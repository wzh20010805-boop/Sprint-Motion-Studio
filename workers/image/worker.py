"""本地 CPU 抠图与非破坏性遮罩；JSON 文件协议，模型不会隐式下载。"""
import hashlib
import json
import math
import os
import sys
import shutil
import zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageChops, ImageStat, ImageOps


def require_model(directory, model):
    if model not in ('u2netp', 'u2net'):
        raise ValueError('仅支持本地 u2netp / u2net 模型')
    path = Path(directory) / (model + '.onnx')
    if not path.is_file():
        raise FileNotFoundError('MODEL_NOT_READY: 请先下载或导入本地模型')
    if model == 'u2netp' and hashlib.sha256(path.read_bytes()).hexdigest() != '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8':
        raise ValueError('MODEL_INVALID: 本地模型校验失败，请手动重新导入')
    return path


def local_session(model_path, model):
    # 覆盖仅“取得权重路径”的接口。即使权重损坏/丢失也不会调用 pooch 自动联网修复。
    import onnxruntime as ort
    from rembg.sessions.u2netp import U2netpSession
    from rembg.sessions.u2net import U2netSession
    parent = U2netpSession if model == 'u2netp' else U2netSession
    class LocalSession(parent):
        @classmethod
        def download_models(cls, *args, **kwargs):
            if not model_path.is_file():
                raise FileNotFoundError('MODEL_NOT_READY: 模型文件已丢失')
            return str(model_path)
    options = ort.SessionOptions()
    options.inter_op_num_threads = options.intra_op_num_threads = 2
    return LocalSession(model, options, providers=['CPUExecutionProvider'])


def region_box(region, size):
    if region is None:
        return (0, 0, *size)
    x, y, w, h = region
    if not all(isinstance(v, int) for v in region) or x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > size[0] or y + h > size[1]:
        raise ValueError('前景区域超出源图或为空')
    return x, y, x + w, y + h


def paint(mask, strokes):
    result = mask.copy().convert('L')
    draw = ImageDraw.Draw(result)
    for stroke in strokes:
        mode, width, points = stroke['mode'], stroke['size'], stroke['points']
        if mode not in ('erase', 'restore') or not isinstance(width, (int, float)) or not math.isfinite(width) or not 1 <= width <= 512 or not points:
            raise ValueError('笔刷参数无效')
        for point in points:
            if len(point) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in point):
                raise ValueError('笔刷坐标无效')
            if not (0 <= point[0] < mask.width and 0 <= point[1] < mask.height):
                raise ValueError('笔刷坐标超出源图')
        color = 0 if mode == 'erase' else 255
        # 直径1采用单像素线，避免椭圆两端整数取整变为两像素。
        if len(points) > 1:
            draw.line([tuple(p) for p in points], fill=color, width=round(width))
        for x, y in points:
            if width == 1:
                draw.point((round(x), round(y)), fill=color)
            else:
                r = (width - 1) / 2
                draw.ellipse((x-r, y-r, x+r, y+r), fill=color)
    return result


def compose(raw, mask):
    if raw.size != mask.size:
        raise ValueError('遮罩尺寸必须与原图一致')
    result = raw.convert('RGBA').copy()
    result.putalpha(ImageChops.multiply(result.getchannel('A'), mask.convert('L')))
    return result


def plain_background_mask(crop, background_points=None):
    """边缘近纯色时只去除与外边连通的背景，保留内部浅色与分离装备。"""
    import numpy as np
    from scipy.ndimage import label, binary_dilation
    pixels = np.asarray(crop.convert('RGBA')).astype(np.int16)
    edge = np.concatenate((pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]))
    if np.min(edge[:, 3]) < 250:
        return None
    background = np.median(edge[:, :3], axis=0)
    edge_distance = np.max(np.abs(edge[:, :3] - background), axis=1)
    if np.percentile(edge_distance, 98) > 12:
        return None
    distance = np.max(np.abs(pixels[:, :, :3] - background), axis=2)
    # scipy 是 rembg 现有依赖；C 实现的四邻域标记替代逐像素 Python floodfill。
    padded = np.pad(distance <= 20, 1, constant_values=True)
    labels, count = label(padded)
    selected = np.zeros(count + 1, dtype=bool)
    selected[labels[0, 0]] = True
    shadow_regions = []
    for point in background_points or []:
        if len(point) != 2 or not all(isinstance(v, int) and not isinstance(v, bool) for v in point):
            raise ValueError('INVALID_BACKGROUND_POINT: 背景点须为整数像素坐标')
        x, y = point
        if not 0 <= x < crop.width or not 0 <= y < crop.height:
            raise ValueError('INVALID_BACKGROUND_POINT: 背景点越界')
        if distance[y, x] <= 20:
            selected[labels[y + 1, x + 1]] = True
        else:
            color = pixels[y, x, :3]
            # 显式标记的浅色地面阴影；深色/高饱和角色点仍拒绝。
            if y < crop.height * .75 or color.min() < 160 or color.max()-color.min() > 36 or distance[y, x] > 80:
                raise ValueError('INVALID_BACKGROUND_POINT: 点不是近背景色或浅色地面阴影')
            shadow_labels, _ = label(np.max(np.abs(pixels[:, :, :3]-color), axis=2) <= 20)
            shadow_regions.append(shadow_labels == shadow_labels[y, x])
    connected = selected[labels[1:-1, 1:-1]]
    for region in shadow_regions:
        connected |= region
    # 连通近背景色全部透明，避免压缩噪声变成整片灰雾；内部浅色仍保留。
    alpha = np.where(connected, 0, 255).astype('uint8')
    # 仅柔化贴背景的一像素浅色混合边，内部白衣和深色轮廓保持。
    fringe = binary_dilation(connected) & ~connected & (distance < 40)
    alpha[fringe] = np.clip((distance[fringe]-20)*255/20, 0, 255).astype('uint8')
    return Image.fromarray(alpha)


def inspect(mask, allow_soft=False):
    histogram = mask.histogram()
    count = mask.width * mask.height
    foreground = count - histogram[0]
    visible = foreground if allow_soft else sum(histogram[129:])
    reasons = []
    if foreground == 0: reasons.append('EMPTY_MASK')
    elif not allow_soft and visible < max(4, count * .0001): reasons.append('LOW_CONFIDENCE')
    if histogram[255] == count: reasons.append('OPAQUE_MASK')
    if foreground / count < .005: reasons.append('SMALL_FOREGROUND')
    border = [mask.getpixel((x, 0)) for x in range(mask.width)] + [mask.getpixel((x, mask.height-1)) for x in range(mask.width)] + [mask.getpixel((0, y)) for y in range(mask.height)] + [mask.getpixel((mask.width-1, y)) for y in range(mask.height)]
    if any(v > 32 for v in border): reasons.append('TOUCHES_BORDER')
    return {'reasons': reasons, 'foreground_fraction': foreground/count, 'visible_fraction': visible/count, 'soft_pixels': sum(histogram[1:255]), 'alpha_range': list(mask.getextrema())}


def verify_archive(request):
    """对服务预先固定的清单校验实际 ZIP；不从松散文件或包内 checksums 推导新期望。"""
    expected = request['files']
    if not isinstance(expected, dict) or not expected:
        raise ValueError('DELIVERY_ARCHIVE_CHANGED: missing expected inventory')
    def digest(stream):
        value = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
        return value.hexdigest()
    with (Path(request['directory']).resolve() / 'assets.zip').open('rb') as source:
        before = digest(source)
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or set(names) != set(expected):
                raise ValueError('DELIVERY_ARCHIVE_CHANGED: entry inventory mismatch')
            for name in names:
                with archive.open(name) as entry:
                    if digest(entry) != expected[name]:
                        raise ValueError('DELIVERY_ARCHIVE_CHANGED: entry hash mismatch: ' + name)
        source.seek(0)
        if digest(source) != before:
            raise ValueError('DELIVERY_ARCHIVE_CHANGED: archive changed during verification')
    return {'archive_sha256': before, 'files': expected}


def main(request):
    if request['action'] == 'verify_archive':
        return verify_archive(request)
    if request['action'] == 'check_candidate':
        from candidate_checks import check_candidate
        return check_candidate(request)
    if request['action'] == 'archive':
        directory = Path(request['directory']).resolve()
        with zipfile.ZipFile(directory / 'assets.zip', 'x', compression=zipfile.ZIP_DEFLATED) as archive:
            for name in request['files']:
                source = (directory / name).resolve()
                if not source.is_relative_to(directory):
                    raise ValueError('非法归档路径')
                archive.write(source, name)
        return {'file': 'assets.zip'}
    if request['action'] in ('compose', 'export'):
        from compose import compose_request
        return compose_request(request)
    action = request['action']
    if action == 'doctor':
        import importlib.metadata
        import onnxruntime
        path = require_model(request['models'], request['model'])
        return {'model': request['model'], 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size, 'rembg': importlib.metadata.version('rembg'), 'onnxruntime': onnxruntime.__version__, 'provider': 'CPUExecutionProvider'}
    session = None
    remove = None
    if action == 'batch':
        model_path = require_model(request['models'], request['model'])
    entries = []
    cache_hits = 0
    for index, frame in enumerate(request['frames']):
        cache = None
        if action == 'batch' and request.get('cache'):
            fingerprint = hashlib.sha256(json.dumps({'raw': hashlib.sha256(Path(frame['raw']).read_bytes()).hexdigest(), 'model': hashlib.sha256(model_path.read_bytes()).hexdigest(), 'region': request.get('region'), 'background_points': request.get('background_points', {}).get(frame['id'], []), 'algorithm': 'p2-edge-rembg-v5'}, sort_keys=True).encode()).hexdigest()
            cache = Path(request['cache']) / fingerprint
            try:
                saved = json.loads((cache / 'checkpoint.json').read_text())
                for kind in ('mask', 'rgba', 'preview'):
                    if hashlib.sha256((cache / (kind+'.png')).read_bytes()).hexdigest() != saved['hashes'][kind]:
                        raise ValueError('损坏缓存')
                for kind in ('mask', 'rgba', 'preview'):
                    shutil.copyfile(cache / (kind+'.png'), frame[kind])
                entries.append({**saved['entry'], 'id': frame['id']})
                cache_hits += 1
                print(json.dumps({'progress': index+1, 'total': len(request['frames'])}), flush=True)
                continue
            except (OSError, ValueError, KeyError, TypeError):
                pass
        raw = Image.open(frame['raw']).convert('RGBA')
        method = 'brush' if action == 'edit' else 'existing'
        if action == 'batch':
            box = region_box(request.get('region'), raw.size)
            crop = raw.crop(box)
            # 纯色/近纯色背景也会被小模型归一化成噪声，不能当作有角色。
            if max(ImageStat.Stat(crop).stddev) < 2:
                raise ValueError(f'REGION_NO_FOREGROUND: 帧 {index+1} 的区域几乎全是背景。请框住角色及装备，或使用完整画面重新生成；上一版保留。')
            points = request.get('background_points', {}).get(frame['id'], [])
            if any(not box[0] <= p[0] < box[2] or not box[1] <= p[1] < box[3] for p in points):
                raise ValueError('INVALID_BACKGROUND_POINT: 背景点不在保留区域内')
            crop_mask = plain_background_mask(crop, [[p[0]-box[0], p[1]-box[1]] for p in points])
            method = 'edge_color' if crop_mask is not None else 'rembg'
            if crop_mask is None:
                if points:
                    raise ValueError('BACKGROUND_POINTS_REQUIRE_PLAIN_BACKGROUND: 背景点只适用于近纯色背景')
                # 仅复杂背景加载模型；纯色帧和缓存命中不承担 rembg/JIT 初始化成本。
                if session is None:
                    os.environ['U2NET_HOME'] = request['models']
                    os.environ['OMP_NUM_THREADS'] = '2'
                    # 此路径仅做 ONNX 遮罩推理；避免 rembg 导入时编译未使用的 PyMatting 函数。
                    os.environ.setdefault('NUMBA_DISABLE_JIT', '1')
                    from rembg import remove
                    session = local_session(model_path, request['model'])
                crop_mask = remove(crop, session=session, only_mask=True, post_process_mask=False).convert('L')
            mask = Image.new('L', raw.size, 0)
            mask.paste(crop_mask, box[:2])
        elif action == 'edit':
            mask = paint(Image.open(frame['input_mask']).convert('L'), request['strokes'])
        elif action == 'validate':
            mask = Image.open(frame['input_mask']).convert('L')
        elif action == 'import':
            if Image.open(frame['raw']).format != 'PNG':
                raise ValueError('INVALID_INPUT: 序列仅接受PNG文件')
            if raw.width > 8192 or raw.height > 8192:
                raise ValueError('INVALID_INPUT: 单张输入尺寸超出8192像素')
            mask = Image.new('L', raw.size, 255)
        else:
            raise ValueError('未知图像操作')
        rgba = compose(raw, mask)
        info = inspect(rgba.getchannel('A'), allow_soft=True) if action in ('import','edit') else inspect(mask)
        if action == 'batch' and any(reason in info['reasons'] for reason in ('EMPTY_MASK', 'LOW_CONFIDENCE')):
            raise ValueError(f'MATTE_NO_FOREGROUND: 帧 {index+1} 未识别到可见角色。请调整保留区域，或使用完整画面重新生成；上一版保留。')
        mask.save(frame['mask'])
        rgba.save(frame['rgba'])
        preview = Image.new('RGBA', raw.size, (38, 26, 61, 255))
        preview.alpha_composite(rgba)
        preview.thumbnail((320, 320))
        preview.save(frame['preview'])
        entries.append({'id': frame['id'], 'width': raw.width, 'height': raw.height, 'method': method, **info})
        if cache:
            cache.mkdir(parents=True, exist_ok=True)
            hashes = {}
            for kind in ('mask', 'rgba', 'preview'):
                shutil.copyfile(frame[kind], cache / (kind+'.png'))
                hashes[kind] = hashlib.sha256((cache / (kind+'.png')).read_bytes()).hexdigest()
            temporary = cache / ('checkpoint-' + str(os.getpid()) + '.tmp')
            temporary.write_text(json.dumps({'entry': entries[-1], 'hashes': hashes}))
            temporary.replace(cache / 'checkpoint.json')
        print(json.dumps({'progress': index+1, 'total': len(request['frames'])}), flush=True)
    return {'frames': entries, 'session_count': 1 if session else 0, 'cache_hits': cache_hits}


if __name__ == '__main__':
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        result = main(request)
        Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
