"""实际解码PNG并生成合成测试检查图；不判断武器/人物美术质量。"""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw

p = argparse.ArgumentParser()
p.add_argument("directory", type=Path)
p.add_argument("output", type=Path)
args = p.parse_args()
files = sorted(args.directory.glob("*.png"))
if not files:
    raise SystemExit("没有PNG")
args.output.mkdir(parents=True, exist_ok=True)
records = []
cols = 8
w, h = 160, 142
sheet = Image.new("RGB", (cols*w, ((len(files)+cols-1)//cols)*h), "#20242c")
draw = ImageDraw.Draw(sheet)
previous = None
for i, file in enumerate(files):
    with Image.open(file) as image:
        image.load()
        rgba = image.convert("RGBA")
        alpha = rgba.getchannel("A")
        extrema = alpha.getextrema()
        digest = hashlib.sha256(rgba.tobytes()).hexdigest()
        records.append({"file": file.name, "mode": image.mode, "size": list(image.size),
                        "alpha_min": extrema[0], "alpha_max": extrema[1],
                        "fully_opaque": extrema == (255, 255), "empty": extrema[1] == 0,
                        "duplicate_previous": digest == previous, "rgba_sha256": digest})
        previous = digest
        rgba.thumbnail((160, 120))
        x, y = (i % cols)*w, (i // cols)*h
        for cy in range(0, 120, 10):
            for cx in range(0, 160, 10):
                color = "#777777" if (cx//10+cy//10) % 2 else "#bbbbbb"
                draw.rectangle((x+cx, y+cy, x+cx+9, y+cy+9), fill=color)
        sheet.paste(rgba, (x, y), rgba)
        draw.text((x+4, y+122), str(i), fill="white")
report = {"sample_kind": "synthetic", "frame_count": len(files),
          "size_consistent": len({tuple(r["size"]) for r in records}) == 1,
          "all_rgba": all(r["mode"] == "RGBA" for r in records),
          "fully_opaque_count": sum(r["fully_opaque"] for r in records),
          "empty_count": sum(r["empty"] for r in records),
          "art_quality": "not_evaluated", "matting": "not_executed", "frames": records}
(args.output/"png-inspection.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
sheet.save(args.output/"contact-sheet.png")
print(json.dumps({k:v for k,v in report.items() if k != "frames"}, ensure_ascii=False))
