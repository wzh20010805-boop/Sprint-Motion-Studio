import sys
from pathlib import Path
import pytest
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compose import root_at, compose_frame, check_bounds, export_package


def config(**kw):
    return dict(canvas={'width': 32, 'height': 32}, anchor=[16, 28], scale=1,
                resampling='pixel', mode='ground_keyframes', roots=[
                    {'index': 0, 'x': 10, 'y': 20}, {'index': 2, 'x': 14, 'y': 20}], offsets={}, **kw)


def test_roots_interpolate_exactly_and_clamp():
    c = config()
    assert root_at(c, 0) == (10, 20)
    assert root_at(c, 1) == (12, 20)
    assert root_at(c, 2) == (14, 20)
    assert root_at(c, 5) == (14, 20)


def test_alignment_removes_root_translation_preserves_body_bob_and_weapon():
    c = config()
    a = Image.new('RGBA', (40, 40))
    a.putpixel((10, 15), (200, 40, 80, 255))
    a.putpixel((20, 10), (0, 240, 0, 255))  # detached weapon
    b = Image.new('RGBA', (40, 40))
    b.putpixel((12, 13), (200, 40, 80, 255))
    assert compose_frame(a, c, 0).getpixel((16, 23))[3] == 255
    assert compose_frame(b, c, 1).getpixel((16, 21))[3] == 255
    assert compose_frame(a, c, 0).getpixel((26, 18))[3] == 255


def test_bounds_report_weapon_overflow_without_changing_scale():
    a = Image.new('RGBA', (80, 40))
    a.putpixel((79, 2), (255, 255, 255, 255))
    c = config()
    report = check_bounds(a, c, 0)
    assert report['overflow'] is True
    assert c['scale'] == 1


def test_jump_crouch_and_death_preserve_motion_above_explicit_ground():
    c = dict(canvas={'width': 64, 'height': 64}, anchor=[32, 58], scale=1,
             resampling='pixel', mode='fixed', roots=[{'index': 0, 'x': 32, 'y': 58}], offsets={})
    poses = [(28, 10, 36, 26), (25, 35, 40, 54), (10, 52, 50, 58)]
    for index, box in enumerate(poses):
        raw = Image.new('RGBA', (64, 64))
        ImageDraw.Draw(raw).rectangle(box, fill=(255, 90, 130, 255))
        aligned = compose_frame(raw, c, index)
        assert aligned.tobytes() == raw.tobytes()
        assert root_at(c, index) == (32, 58)


def test_cartoon_scales_premultiplied_alpha_no_hidden_color_bleed():
    a = Image.new('RGBA', (2, 1), (0, 0, 255, 0))
    a.putpixel((0, 0), (255, 0, 0, 255))
    c = dict(canvas={'width': 8, 'height': 4}, anchor=[0, 0], scale=3,
             resampling='cartoon', mode='fixed', roots=[{'index': 0, 'x': 0, 'y': 0}], offsets={})
    out = compose_frame(a, c, 0)
    semi = [p for p in out.get_flattened_data() if 0 < p[3] < 255]
    assert semi
    assert all(p[0] >= 250 and p[2] == 0 for p in semi)


def test_multi_page_export_preserves_rgba_rectangles_and_variable_timing(tmp_path):
    frames = []
    for i in range(5):
        path = tmp_path / f'input{i}.png'
        Image.new('RGBA', (32, 32), (i*30, 50, 100, 125)).save(path)
        frames.append({'id': f'f{i}', 'path': str(path), 'duration': {'num': i+1, 'den': 24}, 'source_index': i})
    c = dict(canvas={'width': 32, 'height': 32}, anchor=[0, 0], scale=1,
             resampling='pixel', mode='fixed', roots=[{'index': 0, 'x': 0, 'y': 0}], offsets={})
    out = tmp_path / 'out'
    result = export_package({'frames': frames, 'alignment': c, 'directory': str(out), 'max_texture': 70, 'gap': 2, 'margin': 1, 'draft': True})
    assert len(result['sheets']) == 2
    assert result['duration'] == {'num': 5, 'den': 8}
    assert result['release_mode'] == 'draft'
    for item in result['frames']:
        png = Image.open(out / item['file'])
        sheet = Image.open(out / item['sheet'])
        x, y, w, h = item['rect']
        assert png.mode == 'RGBA'
        assert png.tobytes() == sheet.crop((x, y, x+w, y+h)).tobytes()
