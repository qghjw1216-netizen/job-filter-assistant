# -*- coding: utf-8 -*-
"""生成 Apple 科技简约风图标：圆角矩形 + 柔和渐变 + 极简放大镜/对勾字形。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

# 品牌主色：科技蓝 -> 青，Apple 质感的柔和渐变
TOP = (10, 132, 255)      # systemBlue
BOT = (48, 209, 176)      # systemTeal/green


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius, scale=4):
    """超采样抗锯齿的圆角遮罩。"""
    big = size * scale
    r = radius * scale
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=r, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def make(size):
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    px = img.load()
    # 垂直渐变
    for y in range(big):
        t = y / (big - 1)
        c = lerp(TOP, BOT, t)
        for x in range(big):
            px[x, y] = (c[0], c[1], c[2], 255)

    d = ImageDraw.Draw(img)
    # 极简放大镜（镜圈 + 手柄），线宽随尺寸缩放
    cx, cy = int(big * 0.44), int(big * 0.42)
    rr = int(big * 0.20)
    lw = max(2, int(big * 0.055))
    white = (255, 255, 255, 255)
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=white, width=lw)
    # 手柄
    hx1, hy1 = int(cx + rr * 0.72), int(cy + rr * 0.72)
    hx2, hy2 = int(big * 0.72), int(big * 0.72)
    d.line([hx1, hy1, hx2, hy2], fill=white, width=int(lw * 1.15))
    # 镜内对勾（筛选“匹配”语义）
    ck = [
        (int(cx - rr * 0.42), int(cy + rr * 0.02)),
        (int(cx - rr * 0.08), int(cy + rr * 0.38)),
        (int(cx + rr * 0.5), int(cy - rr * 0.4)),
    ]
    d.line(ck, fill=white, width=int(lw * 0.9), joint="curve")

    img = img.resize((size, size), Image.LANCZOS)
    # 圆角裁切
    radius = round(size * 0.225)  # Apple squircle 近似
    mask = rounded_mask(size, radius)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


for s in (16, 32, 48, 96, 128):
    make(s).save(os.path.join(OUT, f"{s}.png"))
    print("wrote", f"{s}.png")
print("done")
