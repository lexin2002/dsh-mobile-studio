"""从官方 1024 图标生成安卓各尺寸图标。

2026-10-26 改版背景：官方图是「白色圆角方板 + 鲸鱼」。旧脚本把整张图缩进
108dp 画布的 66dp 安全区、背景用 #FBFBFB —— 结果白板外又套了一圈白底，
用户原话「特别像一个盗版软件图标」。

现在的做法：
1. 从官方图里只取**鲸鱼本体**（按亮度抠出深色像素，浅色全部变透明），
   白板那道内框从根上没了；
2. 把鲸鱼居中放进 108dp 画布（宽度占 75%），底色统一用官方板色 #F7F8F9；
3. 传统图标（API<26 兜底）用同一套构图，避免透明角被画成黑角。

运行：python tools/make-icon.py
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(os.path.dirname(HERE), "android", "res")

# 源图标（官方"白板 + 鲸鱼"那张图）。发布版不内置官方素材：
#   优先 --src 参数，其次环境变量 DSH_ICON_SRC，最后仓库内 assets/icon-src.png。
# 找不到就跳过（已提交的 mipmap PNG 继续用），不让出包失败。
SRC = ""
for i, a in enumerate(sys.argv):
    if a == "--src" and i + 1 < len(sys.argv):
        SRC = sys.argv[i + 1]
if not SRC:
    SRC = os.environ.get("DSH_ICON_SRC", "")
if not SRC:
    SRC = os.path.join(os.path.dirname(HERE), "assets", "icon-src.png")

PLATE = (247, 248, 249, 255)   # 官方板色，实测取边缘像素
WHALE = (46, 50, 58, 255)      # 官方鲸鱼色，实测取中心像素
# 亮度区间：>=LIGHT 完全透明，<=DARK 完全不透明，中间按比例过渡（抗锯齿）
LIGHT = 170
DARK = 60
WHALE_W = 0.54                 # 鲸鱼宽度占 108dp 画布比例：遮罩只显示中间 72dp，必须留边

DENSITIES = [("mdpi", 1.0), ("hdpi", 1.5), ("xhdpi", 2.0), ("xxhdpi", 3.0), ("xxxhdpi", 4.0)]


def whale_rgba(src):
    """把官方图抠成「只有鲸鱼」的 RGBA：浅色变透明，边缘按亮度做抗锯齿。"""
    px = src.load()
    w, h = src.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            # 透明边里的像素是 (0,0,0,alpha≈0)：只看接近不透明的
            if a < 128:
                continue
            luma = 0.299 * r + 0.587 * g + 0.114 * b
            if luma >= LIGHT:
                continue
            alpha = 255 if luma <= DARK else int(round((LIGHT - luma) * 255.0 / (LIGHT - DARK)))
            op[x, y] = (WHALE[0], WHALE[1], WHALE[2], alpha)
            minx = min(minx, x); miny = min(miny, y)
            maxx = max(maxx, x); maxy = max(maxy, y)
    if maxx < 0:
        return None
    return out.crop((minx, miny, maxx + 1, maxy + 1))


def compose(whale, size):
    """把鲸鱼按 75% 宽居中放进 size×size 的板色底。"""
    base = Image.new("RGBA", (size, size), PLATE)
    target_w = max(1, int(round(size * WHALE_W)))
    ratio = target_w / float(whale.width)
    target_h = max(1, int(round(whale.height * ratio)))
    mark = whale.resize((target_w, target_h), Image.LANCZOS)
    base.alpha_composite(mark, ((size - target_w) // 2, (size - target_h) // 2))
    return base


def main():
    if not os.path.exists(SRC):
        print("没有源图标（用 --src 或 DSH_ICON_SRC 指定），沿用已有 mipmap PNG: " + SRC)
        return 0
    src = Image.open(SRC).convert("RGBA")
    whale = whale_rgba(src)
    if whale is None:
        print("没从官方图里抠到鲸鱼（亮度阈值需要调整）", file=sys.stderr)
        return 1
    print("鲸鱼原始尺寸: %dx%d" % whale.size)

    for name, k in DENSITIES:
        out = os.path.join(RES, "mipmap-" + name)
        os.makedirs(out, exist_ok=True)

        legacy = int(round(48 * k))
        compose(whale, legacy).convert("RGB").save(os.path.join(out, "ic_launcher.png"))

        canvas = int(round(108 * k))
        compose(whale, canvas).save(os.path.join(out, "ic_launcher_fg.png"))

        print("  %-8s legacy=%dpx foreground=%dpx" % (name, legacy, canvas))
    return 0


if __name__ == "__main__":
    sys.exit(main())
