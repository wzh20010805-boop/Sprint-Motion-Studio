"""检查已经保存的候选像素，绝不重新渲染或覆盖候选。"""
import hashlib
import math
from pathlib import Path
from PIL import Image, ImageChops
from compose import check_bounds, candidate_mapping, root_at


def check_candidate(request):
    root = Path(request['directory']).resolve()
    manifest = request['manifest']
    errors, warnings = [], []
    def error(code, frame_id=None, detail=None):
        errors.append(dict(code=code, **({'frame_id': frame_id} if frame_id else {}), **({'detail': detail} if detail else {})))
    def load(file, digest, size, frame_id=None, rgba=True):
        try:
            path = (root/file).resolve()
            if not path.is_relative_to(root):
                raise ValueError('PATH_OUTSIDE_CANDIDATE')
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                error('FILE_HASH_MISMATCH', frame_id, file)
            with Image.open(path) as image:
                if image.format != 'PNG':
                    raise ValueError('NOT_PNG')
                image.load()
                if image.size != tuple(size):
                    error('IMAGE_DIMENSION_MISMATCH', frame_id, file)
                return image.convert('RGBA' if rgba else 'L')
        except (OSError, ValueError, SyntaxError) as exc:
            error('IMAGE_INVALID', frame_id, file+': '+str(exc))
            return None
    config = manifest['alignment']
    canvas = (config['canvas']['width'], config['canvas']['height'])
    grid = manifest['grid']
    cols, rows, gap, margin = grid['columns'],grid['rows'],grid['gap'],grid['margin']
    slots = cols*rows
    if grid['cell'] != list(canvas) or len(manifest['sheets']) != math.ceil(len(manifest['frames'])/slots):
        error('SHEET_LAYOUT_MISMATCH')
    for index,s in enumerate(manifest['sheets']):
        count = min(slots,len(manifest['frames'])-index*slots)
        expected = (2*margin+min(cols,count)*(canvas[0]+gap)-gap,2*margin+math.ceil(count/cols)*(canvas[1]+gap)-gap)
        if (s['width'],s['height']) != expected: error('SHEET_LAYOUT_MISMATCH', detail=s['file'])
        # 逐页完整解码，但不把所有大图集同时留在内存。
        load(s['file'],s['sha256'],(s['width'],s['height']))
    page_index_loaded, page = None, None
    for frame in manifest['frames']:
        fid, files = frame['frame_id'], frame['files']
        size = (frame['source_size']['width'], frame['source_size']['height'])
        raw = load(files['raw'], frame['raw_sha256'], size, fid)
        mask = load(files['mask'], frame['mask_sha256'], size, fid, False)
        rgba = load(files['rgba'], frame['rgba_sha256'], size, fid)
        png = load(files['png'], frame['png_sha256'], canvas, fid)
        if png is not None and png.getchannel('A').getbbox() is None:
            error('EMPTY_FRAME', fid)
        if raw is not None and mask is not None and rgba is not None and raw.size == mask.size == rgba.size:
            expected = raw.copy()
            expected.putalpha(ImageChops.multiply(raw.getchannel('A'), mask))
            if expected.tobytes() != rgba.tobytes():
                error('RGBA_INPUT_MISMATCH', fid)
        if rgba is not None and png is not None:
            check = check_bounds(rgba, config, frame['sequence_index'], frame['resolved_transform'], png)
            if check['overflow']: error('FRAME_CLIPPED', fid)
            mapping = candidate_mapping(rgba, config, frame['sequence_index'], frame['resolved_transform'])
            if mapping != frame['source_to_canvas']: error('AFFINE_MISMATCH', fid)
            if list(root_at(config, frame['sequence_index'])) != [frame['resolved_root']['x'],frame['resolved_root']['y']]: error('ROOT_MISMATCH', fid)
        provenance = frame['mask_provenance']
        for reason in provenance['reasons']:
            if provenance['kind'] == 'automatic' and reason in ('LOW_CONFIDENCE','EMPTY_MASK'):
                error(reason, fid)
            else:
                warnings.append(dict(code=reason, frame_id=fid))
        cell = frame['grid_cell']
        x,y,w,h = cell['rect']
        page_index = cell['sheet_index']
        slot = frame['sequence_index'] % slots
        if page_index != frame['sequence_index']//slots or [x,y,w,h] != [margin+(slot%cols)*(canvas[0]+gap),margin+(slot//cols)*(canvas[1]+gap),*canvas]:
            error('SHEET_LAYOUT_MISMATCH', fid)
        if page_index >= len(manifest['sheets']) or (w,h) != canvas:
            error('SHEET_RECT_INVALID', fid)
        else:
            if page_index != page_index_loaded:
                s=manifest['sheets'][page_index]
                page=load(s['file'],s['sha256'],(s['width'],s['height']))
                page_index_loaded=page_index
            if page is not None:
                if x < 0 or y < 0 or x+w > page.width or y+h > page.height:
                    error('SHEET_RECT_INVALID', fid)
                elif png is not None and page.crop((x,y,x+w,y+h)).tobytes() != png.tobytes():
                    error('SHEET_PIXELS_MISMATCH', fid)
    return dict(checked_frame_count=len(manifest['frames']), blocking_errors=errors, warnings=warnings)
