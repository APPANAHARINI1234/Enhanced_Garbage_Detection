"""
WasteVision — Flask backend
Runs YOLOv8s + EfficientViT CGA inference and serves results to the frontend.

Quick start:
  pip install flask ultralytics pillow flask-cors
  python app.py

The server runs on http://localhost:5000
"""

import io
import sys
import torch
import torch.nn as nn
import torch.nn.functional as F

from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image
from ultralytics import YOLO
from ultralytics.nn.modules.block import C2f

# ── Model path ────────────────────────────────────────────────
# Points to your already-extracted folder: efficientvit_100epochs/weights/best.pt
# Place app.py so this relative path resolves, OR use an absolute path:
#   Windows: MODEL_PATH = r"C:\Users\YourName\efficientvit_100epochs\weights\best.pt"
#   Linux/Mac: MODEL_PATH = "/home/yourname/efficientvit_100epochs/weights/best.pt"
MODEL_PATH = "../efficientvit_100epochs/weights/best.pt"

# ── Class names (must match training order) ───────────────────
CLASS_NAMES = [
    'Aluminium foil', 'Bottle cap', 'Bottle', 'Broken glass', 'Can',
    'Carton', 'Cigarette', 'Cup', 'Lid', 'Other litter',
    'Other plastic', 'Paper', 'Plastic bag - wrapper',
    'Plastic container', 'Pop tab', 'Straw', 'Styrofoam piece', 'Unlabeled litter'
]


# ── Re-declare custom modules (needed for torch.load to work) ─
# These must be defined so that PyTorch can deserialise the saved
# model that contains C2f_EfficientViT layers.

class Conv2d_BN(nn.Module):
    def __init__(self, in_ch, out_ch, kernel=1, stride=1, padding=0, groups=1):
        super().__init__()
        self.conv = nn.Conv2d(in_ch, out_ch, kernel, stride, padding, groups=groups, bias=False)
        self.bn   = nn.BatchNorm2d(out_ch)

    def forward(self, x):
        return self.bn(self.conv(x))


class CascadedGroupAttention(nn.Module):
    def __init__(self, dim, num_heads=4, key_dim=16, attn_ratio=4, resolution=40):
        super().__init__()
        self.num_heads  = num_heads
        self.key_dim    = key_dim
        self.d          = int(attn_ratio * key_dim)
        self.scale      = key_dim ** -0.5
        self.resolution = resolution
        N               = resolution * resolution
        head_dim        = dim // num_heads

        self.q_projs  = nn.ModuleList([Conv2d_BN(head_dim, key_dim) for _ in range(num_heads)])
        self.k_projs  = nn.ModuleList([Conv2d_BN(head_dim, key_dim) for _ in range(num_heads)])
        self.v_projs  = nn.ModuleList([Conv2d_BN(head_dim, self.d)  for _ in range(num_heads)])
        self.dw_convs = nn.ModuleList([
            Conv2d_BN(head_dim, head_dim, kernel=5, padding=2, groups=head_dim)
            for _ in range(num_heads)
        ])
        self.proj      = Conv2d_BN(self.d * num_heads, dim)
        self.proj_act  = nn.ReLU()
        self.attention_biases = nn.Parameter(torch.zeros(num_heads, N))

    def forward(self, x):
        B, C, H, W = x.shape
        N          = H * W
        head_dim   = C // self.num_heads
        x_heads    = x.split(head_dim, dim=1)
        attn_outputs, prev = [], None

        for i in range(self.num_heads):
            xi = self.dw_convs[i](x_heads[i])
            if prev is not None:
                xi = xi + prev
            q = self.q_projs[i](xi)
            k = self.k_projs[i](xi)
            v = self.v_projs[i](xi)
            q_flat = q.reshape(B, self.key_dim, N).permute(0, 2, 1)
            k_flat = k.reshape(B, self.key_dim, N)
            v_flat = v.reshape(B, self.d, N).permute(0, 2, 1)
            attn   = (q_flat @ k_flat) * self.scale
            if N == self.resolution * self.resolution:
                attn = attn + self.attention_biases[i].unsqueeze(0).unsqueeze(0)
            attn   = attn.softmax(dim=-1)
            out    = (attn @ v_flat).permute(0, 2, 1).reshape(B, self.d, H, W)
            attn_outputs.append(out)
            prev   = out[:, :head_dim, :, :]

        out = torch.cat(attn_outputs, dim=1)
        return self.proj_act(self.proj(out))


class EfficientViTBlock(nn.Module):
    def __init__(self, dim, num_heads=4, key_dim=16, attn_ratio=4, resolution=40, expansion=4):
        super().__init__()
        self.ffn1 = nn.Sequential(Conv2d_BN(dim, dim * expansion), nn.GELU(), Conv2d_BN(dim * expansion, dim))
        self.attn = CascadedGroupAttention(dim, num_heads, key_dim, attn_ratio, resolution)
        self.ffn2 = nn.Sequential(Conv2d_BN(dim, dim * expansion), nn.GELU(), Conv2d_BN(dim * expansion, dim))
        self.ls1  = nn.Parameter(torch.ones(dim, 1, 1) * 1e-5)
        self.ls2  = nn.Parameter(torch.ones(dim, 1, 1) * 1e-5)
        self.ls3  = nn.Parameter(torch.ones(dim, 1, 1) * 1e-5)

    def forward(self, x):
        x = x + self.ls1 * self.ffn1(x)
        x = x + self.ls2 * self.attn(x)
        x = x + self.ls3 * self.ffn2(x)
        return x


class C2f_EfficientViT(nn.Module):
    def __init__(self, c1, c2, n=1, shortcut=True, num_heads=4, key_dim=32, resolution=40):
        super().__init__()
        self.c2f  = C2f(c1, c2, n, shortcut)
        actual_heads = num_heads
        while c2 % actual_heads != 0 and actual_heads > 1:
            actual_heads -= 1
        self.evit = EfficientViTBlock(dim=c2, num_heads=actual_heads, key_dim=key_dim,
                                       attn_ratio=4, resolution=resolution)

    def forward(self, x):
        return self.evit(self.c2f(x))


# ── Flask app ─────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)  # Allow frontend on any origin (restrict in production)

# Load model once at startup
print(f"Loading model from: {MODEL_PATH}")
if not Path(MODEL_PATH).exists():
    print(f"\n  ERROR: Model not found at '{MODEL_PATH}'")
    print("  Extract efficientvit_100epochs.zip and copy weights/best.pt here.\n")
    sys.exit(1)

model = YOLO(MODEL_PATH)
model.overrides['verbose'] = False
print("Model loaded successfully.\n")


@app.route("/health", methods=["GET"])
def health():
    """Frontend polls this to show connection status."""
    return jsonify({"status": "ok", "model": MODEL_PATH, "classes": len(CLASS_NAMES)})


@app.route("/detect", methods=["POST"])
def detect():
    """
    Accepts: multipart/form-data
      - image : image file (JPG, PNG, WEBP)
      - conf  : float confidence threshold (default 0.40)

    Returns: JSON array of detections
      [{ classId, className, conf, x, y, w, h }, ...]
      x, y = top-left pixel; w, h = box dimensions
    """
    if "image" not in request.files:
        return jsonify({"error": "No image field in request"}), 400

    conf_threshold = float(request.form.get("conf", 0.40))
    img_file       = request.files["image"]

    try:
        pil_image = Image.open(io.BytesIO(img_file.read())).convert("RGB")
    except Exception as e:
        return jsonify({"error": f"Cannot read image: {e}"}), 400

    # Run inference
    results = model(pil_image, conf=conf_threshold, imgsz=640, verbose=False)

    detections = []
    for result in results:
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cid = int(box.cls[0])
            detections.append({
                "classId":   cid,
                "className": CLASS_NAMES[cid] if cid < len(CLASS_NAMES) else f"class_{cid}",
                "conf":      round(float(box.conf[0]), 4),
                "x":         round(x1, 1),
                "y":         round(y1, 1),
                "w":         round(x2 - x1, 1),
                "h":         round(y2 - y1, 1),
            })

    return jsonify(detections)


if __name__ == "__main__":
    # debug=False in production; host="0.0.0.0" to expose on network
    app.run(host="0.0.0.0", port=5000, debug=True)