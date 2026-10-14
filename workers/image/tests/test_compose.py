import sys
from pathlib import Path
import pytest
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compose import root_at, compose_frame, check_bounds, export_package


def test_candidate_mapping_canvas_order_negative_scale_real_pixel():
    import compose
    image = Image.new('RGBA', (64, 64))
    image.putpixel((20, 8), (255, 0, 0, 128))
    c = dict(canvas={'width': 96, 'height': 96}, anchor=[48, 80], scale=1,
             resampling='pixel', mode='fixed', roots=[{'index': 0, 'x': 32, 'y': 50}], offsets={})
    t = dict(offset_x=2, offset_y=3, scale=-1, rotation=__import__('math').pi/2, opacity=1)
    mapping = compose.candidate_mapping(image, c, 0, t)
    def point(m, x, y): return (m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5])
    p = point(mapping['matrix'], 20.5, 8.5)
    assert p == pytest.approx((26.5, 76.5))
    assert point(mapping['inverse_matrix'], *p) == pytest.approx((20.5, 8.5))
    assert compose_frame(image, c, 0, t).getpixel((26, 76))[3] == 128
    t['scale'] = 0
    assert compose.candidate_mapping(image, c, 0, t) == dict(matrix=None, inverse_matrix=None, noninvertible_reason='ZERO_DETERMINANT')


def test_candidate_check_rejects_shifted_sheet_rect_even_for_identical_pixels(tmp_path):
    from candidate_checks import check_candidate
    import hashlib
    image = Image.new('RGBA', (32,32), (255,0,0,255))
    image.save(tmp_path/'raw.png')
    Image.new('L',(32,32),255).save(tmp_path/'mask.png')
    c = dict(canvas={'width':32,'height':32},anchor=[0,0],scale=1,resampling='pixel',mode='fixed',roots=[{'index':0,'x':0,'y':0}],offsets={})
    transform = dict(offset_x=0,offset_y=0,scale=1,rotation=0,opacity=1)
    exported = export_package(dict(directory=str(tmp_path),alignment=c,max_texture=64,gap=0,margin=0,frames=[dict(id=str(i),path=str(tmp_path/'raw.png'),index=i,transform=transform,duration={'num':1,'den':24}) for i in range(2)]))
    digest = lambda p: hashlib.sha256((tmp_path/p).read_bytes()).hexdigest()
    frames = [dict(frame_id=str(i),sequence_index=i,files=dict(raw='raw.png',mask='mask.png',rgba='raw.png',png=e['file']),source_size=dict(width=32,height=32),raw_sha256=digest('raw.png'),mask_sha256=digest('mask.png'),rgba_sha256=digest('raw.png'),png_sha256=digest(e['file']),resolved_transform=transform,resolved_root=dict(x=0,y=0),source_to_canvas=e['source_to_canvas'],mask_provenance=dict(kind='imported',reasons=[]),grid_cell=dict(sheet_index=0,rect=e['rect'])) for i,e in enumerate(exported['frames'])]
    manifest=dict(alignment=c,frames=frames,grid=exported['grid'],sheets=[dict(**s,sha256=digest(s['file'])) for s in exported['sheets']])
    assert check_candidate(dict(directory=str(tmp_path),manifest=manifest))['blocking_errors']==[]
    frames[0]['grid_cell']['rect']=[1,0,32,32]
    result=check_candidate(dict(directory=str(tmp_path),manifest=manifest))
    assert any(e['code']=='SHEET_LAYOUT_MISMATCH' for e in result['blocking_errors'])


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


def test_editor_transform_then_alignment_matches_center_anchor_and_alpha():
    import math
    image = Image.new('RGBA', (32, 32))
    image.putpixel((18, 12), (220, 40, 90, 255))
    c = dict(canvas={'width': 80, 'height': 80}, anchor=[32, 32], scale=2,
             resampling='pixel', mode='fixed', roots=[{'index': 0, 'x': 16, 'y': 16}], offsets={'0': [1, -1]})
    transform = dict(offset_x=3, offset_y=-2, scale=1, rotation=math.pi/2, opacity=.5)
    rendered = compose_frame(image, c, 0, transform)
    assert rendered.getpixel((45, 31)) == (220, 40, 90, 128)
    assert rendered.getchannel('A').getbbox() == (45, 31, 47, 33)
    assert check_bounds(image, c, 0, transform)['bounds'] == pytest.approx([45, 31, 47, 33])


def test_editor_scale_is_about_image_center_and_supports_negative_scale():
    image = Image.new('RGBA', (32, 32))
    ImageDraw.Draw(image).rectangle((8, 8, 11, 11), fill=(220, 50, 100, 255))
    c = dict(canvas={'width': 32, 'height': 32}, anchor=[0, 0], scale=1,
             resampling='pixel', mode='fixed', roots=[{'index': 0, 'x': 0, 'y': 0}], offsets={})
    for scale, bounds in [(.5, (12, 12, 14, 14)), (-1, (20, 20, 24, 24))]:
        transform = dict(scale=scale)
        assert compose_frame(image, c, 0, transform).getchannel('A').getbbox() == bounds
        assert check_bounds(image, c, 0, transform)['bounds'] == pytest.approx(bounds)


def test_transformed_bounds_catch_clipping_and_fully_hidden_frames():
    image = Image.new('RGBA', (32, 32))
    ImageDraw.Draw(image).rectangle((8, 8, 11, 11), fill=(220, 50, 100, 255))
    c = dict(canvas={'width': 32, 'height': 32}, anchor=[0, 0], scale=1,
             resampling='pixel', mode='fixed', roots=[{'index': 0, 'x': 0, 'y': 0}], offsets={})
    assert check_bounds(image, c, 0, {'offset_x': 25})['overflow'] is True
    for hidden in [{'opacity': 0}, {'scale': 0}]:
        assert check_bounds(image, c, 0, hidden)['empty'] is True
        assert compose_frame(image, c, 0, hidden).getchannel('A').getbbox() is None


def test_subpixel_foreground_disappearing_during_resampling_is_empty():
    image = Image.new('RGBA', (32, 32))
    ImageDraw.Draw(image).rectangle((8, 8, 11, 11), fill=(220, 50, 100, 255))
    c = dict(canvas={'width': 32, 'height': 32}, anchor=[0, 0], scale=1,
             resampling='pixel', mode='fixed', roots=[{'index': 0, 'x': 0, 'y': 0}], offsets={})
    transform = dict(scale=.1, offset_x=.4, offset_y=.4)
    assert compose_frame(image, c, 0, transform).getchannel('A').getbbox() is None
    report = check_bounds(image, c, 0, transform)
    assert report['bounds'] == pytest.approx([15.6, 15.6, 16, 16])
    assert report['overflow'] is False
    assert report['empty'] is True
