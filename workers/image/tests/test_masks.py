import importlib.util
from pathlib import Path
from PIL import Image, ImageDraw
import pytest
import json

spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

def test_restore_keeps_detached_weapon_and_original_alpha():
    raw = Image.new('RGBA', (32, 32), (80, 120, 200, 255))
    raw.putpixel((28, 4), (80, 120, 200, 128))
    mask = Image.new('L', raw.size, 0)
    edited = worker.paint(mask, [{'mode': 'restore', 'size': 1, 'points': [[28, 4], [28, 20]]}])
    rgba = worker.compose(raw, edited)
    assert rgba.getpixel((28, 4))[3] == 128
    assert rgba.getpixel((28, 20))[3] == 255
    assert rgba.getpixel((0, 0))[3] == 0
    assert mask.getextrema() == (0, 0)

def test_erase_is_local_and_original_colors_remain():
    raw = Image.new('RGBA', (32, 32), (71, 99, 131, 255))
    mask = Image.new('L', raw.size, 180)
    result = worker.compose(raw, worker.paint(mask, [{'mode': 'erase', 'size': 4, 'points': [[16, 16]]}]))
    assert result.getpixel((16, 16)) == (71, 99, 131, 0)
    assert result.getpixel((0, 0)) == (71, 99, 131, 180)

def test_invalid_roi_and_stroke_are_rejected():
    with pytest.raises(ValueError): worker.region_box([1, 1, 0, 20], (32, 32))
    with pytest.raises(ValueError): worker.paint(Image.new('L', (32, 32)), [{'mode': 'restore', 'size': -1, 'points': [[0, 0]]}])

def test_missing_model_fails_without_creating_foreground(tmp_path):
    with pytest.raises(FileNotFoundError): worker.require_model(str(tmp_path), 'u2netp')
    assert list(tmp_path.iterdir()) == []

def test_corrupt_cached_model_is_rejected_without_repair_download(tmp_path):
    model = tmp_path / 'u2netp.onnx'
    model.write_bytes(b'corrupted weights')
    with pytest.raises(ValueError, match='MODEL_INVALID'):
        worker.require_model(str(tmp_path), 'u2netp')
    assert model.read_bytes() == b'corrupted weights'


def test_almost_invisible_noise_is_not_reported_as_valid_foreground():
    # 复现截图任务：大片低alpha噪声和两个较亮噪点，不应算有角色。
    mask = Image.new('L', (1280, 720), 0)
    mask.paste(20, (154, 140, 378, 408))
    mask.putpixel((155, 141), 219)
    mask.putpixel((156, 141), 140)
    assert 'LOW_CONFIDENCE' in worker.inspect(mask)['reasons']


def test_background_only_region_fails_before_generating_draft(tmp_path):
    raw = tmp_path / 'raw.png'
    Image.new('RGB', (64, 64), (225, 218, 210)).save(raw)
    model_dir = Path(__file__).parents[3] / '.models'
    frame = {'id': 'blank', 'raw': str(raw), **{k: str(tmp_path / (k + '.png')) for k in ('mask', 'rgba', 'preview')}}
    with pytest.raises(ValueError, match='REGION_NO_FOREGROUND'):
        worker.main({'action': 'batch', 'models': str(model_dir), 'model': 'u2netp', 'region': [1, 1, 30, 30], 'frames': [frame]})
    assert not Path(frame['rgba']).exists()


def test_plain_background_keeps_solid_equipment_and_detached_thin_weapon(tmp_path):
    raw = tmp_path / 'raw.png'
    image = Image.new('RGB', (64, 64), (225, 218, 210))
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 14, 40, 50), fill=(50, 30, 20))
    draw.rectangle((39, 27, 48, 42), fill=(203, 184, 149))
    draw.line((54, 10, 54, 50), fill=(240, 230, 80), width=1)
    image.save(raw)
    frame = {'id': 'flat-scene', 'raw': str(raw), **{k: str(tmp_path / (k + '.png')) for k in ('mask', 'rgba', 'preview')}}
    worker.main({'action': 'batch', 'models': str(Path(__file__).parents[3] / '.models'), 'model': 'u2netp', 'frames': [frame]})
    rgba = Image.open(frame['rgba'])
    assert rgba.getpixel((54, 10)) == (240, 230, 80, 255)
    assert rgba.getpixel((44, 34)) == (203, 184, 149, 255)
    assert rgba.getpixel((0, 0))[3] == 0


def test_cache_reuses_valid_outputs_and_recovers_bad_json_and_pixels(tmp_path, monkeypatch):
    # 缓存命中不重跑抠图；结构或像素校验失败必须重建，不能永久卡住恢复。
    monkeypatch.setattr(worker, 'local_session', lambda *args: object())
    raw = tmp_path / 'raw.png'
    image = Image.new('RGB', (64, 64), 'white')
    ImageDraw.Draw(image).rectangle((20, 14, 40, 50), fill='red')
    image.save(raw)
    frame = {'id': 'cache', 'raw': str(raw), **{k: str(tmp_path / (k + '.png')) for k in ('mask', 'rgba', 'preview')}}
    request = {'action': 'batch', 'models': str(Path(__file__).parents[3] / '.models'), 'model': 'u2netp', 'frames': [frame], 'cache': str(tmp_path / 'cache')}
    assert worker.main(request)['cache_hits'] == 0
    assert worker.main(request)['cache_hits'] == 1
    checkpoint = next((tmp_path / 'cache').glob('*/checkpoint.json'))
    for malformed in (None, [], {'hashes': None}):
        checkpoint.write_text(json.dumps(malformed))
        assert worker.main(request)['cache_hits'] == 0
        assert worker.main(request)['cache_hits'] == 1
    (checkpoint.parent / 'rgba.png').write_bytes(b'corrupt')
    assert worker.main(request)['cache_hits'] == 0
    assert Image.open(checkpoint.parent / 'rgba.png').getpixel((25, 25))[3] == 255


@pytest.mark.parametrize('alpha', [1, 128])
def test_imported_soft_png_remains_reviewable_without_opaque_core(tmp_path, alpha):
    raw = tmp_path / 'soft.png'
    image = Image.new('RGBA', (32, 32))
    ImageDraw.Draw(image).rectangle((8, 8, 20, 24), fill=(80, 120, 200, alpha))
    image.save(raw)
    frame = {'id': 'soft', 'raw': str(raw), **{k: str(tmp_path / (k+'.png')) for k in ('mask', 'rgba', 'preview')}}
    info = worker.main({'action': 'import', 'frames': [frame]})['frames'][0]
    assert 'LOW_CONFIDENCE' not in info['reasons']
    assert Image.open(frame['rgba']).getpixel((12, 12))[3] == alpha
    edited = worker.main({'action': 'edit', 'frames': [{**frame, 'input_mask': frame['mask']}],
                         'strokes': [{'mode': 'erase', 'size': 1, 'points': [[8, 8]]}]})['frames'][0]
    assert 'LOW_CONFIDENCE' not in edited['reasons']


def test_fully_transparent_png_stays_empty_after_import_and_restore(tmp_path):
    raw = tmp_path / 'empty.png'
    Image.new('RGBA', (16, 16)).save(raw)
    frame = {'id': 'empty', 'raw': str(raw), **{k: str(tmp_path / (k+'.png')) for k in ('mask', 'rgba', 'preview')}}
    assert 'EMPTY_MASK' in worker.main({'action': 'import', 'frames': [frame]})['frames'][0]['reasons']
    info = worker.main({'action': 'edit', 'frames': [{**frame, 'input_mask': frame['mask']}],
                        'strokes': [{'mode': 'restore', 'size': 4, 'points': [[8, 8]]}]})['frames'][0]
    assert 'EMPTY_MASK' in info['reasons']
