"""共享源坐标合成和确定性素材打包。PNG 始终保存 straight alpha。"""
import math
from fractions import Fraction
from pathlib import Path
from PIL import Image, ImageDraw


def root_at(config, index):
    points = sorted(config['roots'], key=lambda p: p['index'])
    if config['mode'] == 'fixed' or index <= points[0]['index']:
        return points[0]['x'], points[0]['y']
    if index >= points[-1]['index']:
        return points[-1]['x'], points[-1]['y']
    for a, b in zip(points, points[1:]):
        if a['index'] <= index <= b['index']:
            t = (index-a['index'])/(b['index']-a['index'])
            return a['x']+(b['x']-a['x'])*t, a['y']+(b['y']-a['y'])*t
    raise ValueError('无效根轨迹')


def translation(config, index):
    rx, ry = root_at(config, index)
    dx, dy = config.get('offsets', {}).get(str(index), [0, 0])
    s = config['scale']
    return config['anchor'][0]+dx-s*rx, config['anchor'][1]+dy-s*ry


def check_bounds(image, config, index):
    bbox = image.getchannel('A').getbbox()
    if bbox is None:
        return {'index': index, 'bounds': None, 'overflow': False, 'empty': True}
    tx, ty = translation(config, index)
    s = config['scale']
    bounds = [bbox[0]*s+tx, bbox[1]*s+ty, bbox[2]*s+tx, bbox[3]*s+ty]
    w, h = config['canvas']['width'], config['canvas']['height']
    return {'index': index, 'bounds': bounds, 'overflow': bounds[0] < 0 or bounds[1] < 0 or bounds[2] > w or bounds[3] > h, 'empty': False}


def compose_frame(image, config, index):
    image = image.convert('RGBA')
    w, h = config['canvas']['width'], config['canvas']['height']
    tx, ty = translation(config, index)
    s = config['scale']
    inverse = (1/s, 0, -tx/s, 0, 1/s, -ty/s)
    if config['resampling'] == 'pixel':
        return image.transform((w, h), Image.Transform.AFFINE, inverse, Image.Resampling.NEAREST)
    # RGBa 的小写 a 是 Pillow 的预乘模式；隐藏像素的颜色不参与插值。
    return image.convert('RGBa').transform((w, h), Image.Transform.AFFINE, inverse,
                                         Image.Resampling.BICUBIC).convert('RGBA')


def export_package(request):
    directory = Path(request['directory'])
    (directory / 'frames').mkdir(parents=True, exist_ok=True)
    (directory / 'sheets').mkdir(exist_ok=True)
    (directory / 'previews').mkdir(exist_ok=True)
    config = request['alignment']
    w, h = config['canvas']['width'], config['canvas']['height']
    maximum = request.get('max_texture', 2048)
    gap, margin = request.get('gap', 2), request.get('margin', 1)
    cols = (maximum-2*margin+gap)//(w+gap)
    rows = (maximum-2*margin+gap)//(h+gap)
    if cols < 1 or rows < 1:
        raise ValueError('TEXTURE_TOO_SMALL: 纹理上限容不下画布和边距')
    entries, sheets, checks = [], [], []
    page = None
    # 联系表只保留最多 256 张缩略图；完整帧和清单从不截断。
    thumb = min(96, w), min(96, h)
    count = min(256, len(request['frames']))
    contact_cols = min(8, count)
    contact = Image.new('RGB', (contact_cols*thumb[0], math.ceil(count/contact_cols)*(thumb[1]+18)), (38, 26, 61))
    elapsed = Fraction(0)
    for i, frame in enumerate(request['frames']):
        source = Image.open(frame['path']).convert('RGBA')
        check = check_bounds(source, config, frame.get('index', i))
        check['frame_id'] = frame['id']
        checks.append(check)
        rendered = compose_frame(source, config, frame.get('index', i))
        file = f'frames/frame_{i+1:06}.png'
        rendered.save(directory / file)
        slot = i % (cols*rows)
        page_number = i // (cols*rows)
        if slot == 0:
            slots = min(cols*rows, len(request['frames'])-i)
            page_cols = min(cols, slots)
            page_rows = math.ceil(slots/cols)
            page = Image.new('RGBA', (2*margin+page_cols*w+(page_cols-1)*gap, 2*margin+page_rows*h+(page_rows-1)*gap))
            sheets.append({'file': f'sheets/page_{page_number+1:03}.png', 'width': page.width, 'height': page.height})
        x, y = margin+(slot % cols)*(w+gap), margin+(slot//cols)*(h+gap)
        page.paste(rendered, (x, y))  # 直接复制 RGBA，不能再次乘 alpha。
        if slot == cols*rows-1 or i == len(request['frames'])-1:
            page.save(directory / sheets[-1]['file'])
        duration = frame['duration']
        elapsed += Fraction(duration['num'], duration['den'])
        entries.append({k: v for k, v in frame.items() if k not in ('path',)})
        entries[-1].update(file=file, sheet=sheets[-1]['file'], rect=[x, y, w, h], root=list(root_at(config, frame.get('index', i))))
        if i < count:
            preview = Image.new('RGBA', rendered.size, (38, 26, 61, 255))
            preview.alpha_composite(rendered)
            preview.thumbnail(thumb)
            px, py = (i % contact_cols)*thumb[0], (i//contact_cols)*(thumb[1]+18)
            contact.paste(preview.convert('RGB'), (px, py))
            ImageDraw.Draw(contact).text((px, py+thumb[1]), str(i+1), fill='white')
        print(__import__('json').dumps({'progress': i+1, 'total': len(request['frames'])}), flush=True)
    contact.save(directory / 'previews/contact-sheet.png')
    return {'frames': entries, 'sheets': sheets, 'checks': checks,
            'duration': {'num': elapsed.numerator, 'den': elapsed.denominator},
            'release_mode': 'draft' if request.get('draft') else 'reviewed',
            'grid': {'cell': [w, h], 'margin': margin, 'gap': gap, 'columns': cols, 'rows': rows},
            'contact_sheet_limit': count}


def compose_request(request):
    if request['action'] == 'export':
        return export_package(request)
    checks = []
    for frame in request['frames']:
        image = Image.open(frame['path']).convert('RGBA')
        checks.append({'frame_id': frame['id'], **check_bounds(image, request['alignment'], frame['index'])})
        if frame.get('output'):
            compose_frame(image, request['alignment'], frame['index']).save(frame['output'])
    return {'checks': checks}
