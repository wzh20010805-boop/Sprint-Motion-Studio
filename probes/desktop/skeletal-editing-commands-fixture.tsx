import { createRoot } from '../../apps/web/node_modules/react-dom/client';
import { createElement, Fragment, useEffect, useState } from '../../apps/web/node_modules/react';
import type { CharacterBinding, Skeleton } from '@framebaker/shared';
import AnimationAssetsWorkspace, { BindingEditor, SkeletonEditor } from '../../apps/web/src/components/AnimationAssetsWorkspace';
import SkeletalProjectEditor from '../../apps/web/src/components/SkeletalProjectEditor';
import { MaterialEditorProvider } from '../../apps/web/src/components/MaterialEditor';
import AppModals from '../../apps/web/src/components/AppModals';
import CropModal from '../../apps/web/src/components/CropModal';
import ColorKeyModal from '../../apps/web/src/components/ColorKeyModal';
import { editingCommands } from '../../apps/web/src/editingCommands';
import { api } from '../../apps/web/src/api';
import { flushPersistence } from '../../apps/web/src/persistence';

// 合成数据通过隔离 HTTP 服务保存；执行真实组件注册的命令，保留错误结果给探针断言。
(window as any).fixtureCommands = {
  state: () => { editingCommands.refresh(); return editingCommands.getSnapshot(); },
  execute: async (command: 'save' | 'undo') => {
    try { return { ok: await editingCommands.execute(command) }; }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  },
  flush: async () => { try { await flushPersistence(); return { ok: true }; } catch (error) { return { ok: false, error: (error as Error).message }; } },
};
function Fixture() {
  const [data, setData] = useState<any>();
  const [skeleton, setSkeleton] = useState<Skeleton>();
  const [binding, setBinding] = useState<CharacterBinding>();
  const [image, setImage] = useState<Blob>();
  useEffect(() => { void fetch('/fixture/data').then(r => r.json()).then(next => { setData(next); setSkeleton(next.skeleton); setBinding(next.document.character.binding); }); }, []);
  useEffect(() => { void fetch('/fixture/image.png').then(r => r.blob()).then(setImage); }, []);
  if (!data || !skeleton || !binding) return null;
  const mode = new URLSearchParams(location.search).get('mode');
  if (mode?.startsWith('crop') || mode?.startsWith('color')) {
    if (!image) return null;
    const confirm = async (blob: Blob, options?: unknown) => {
      const write = api.replaceMaterialImage('material', blob, 'processed');
      if (mode.endsWith('-swallow')) await write.catch(() => {}); else await write;
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      (window as any).fixtureImageOutput = { width: canvas.width, height: canvas.height, options, alphaSum: pixels.filter((_, index) => index % 4 === 3).reduce((sum, value) => sum + value, 0) };
      return true;
    };
    const close = () => (window as any).fixtureClose();
    return mode.startsWith('crop') ? createElement(CropModal, { image, onConfirm: confirm, onClose: close }) : createElement(ColorKeyModal, { image, onConfirm: confirm, onClose: close });
  }
  if (mode === 'skeleton') return createElement(SkeletonEditor, { skeleton, busy: false, onSave: async next => { const saved = await api.putAnimationAsset(next.id, next); setSkeleton(saved.asset as Skeleton); return true; } });
  if (mode === 'binding') return createElement(BindingEditor, { binding, skeleton, materials: data.materials, materialFolders: [], busy: false, onSave: async next => { const saved = await api.putSkeletalProjectDocument('fixture', { ...data.document, character: { binding: next } }); setBinding(saved.character!.binding); return true; } });
  if (mode === 'project') return createElement(SkeletalProjectEditor, { project: data.project, onBack: () => {} });
  return createElement(AnimationAssetsWorkspace, { onOpenProjects: () => {}, initialAssetId: mode === 'workspace-skeleton' ? skeleton.id : 'motion-fixture', previewBinding: mode === 'clip-parts' ? binding : undefined });
}
const root = createRoot(document.getElementById('root')!);
(window as any).fixtureClose = () => root.unmount();
root.render(createElement(MaterialEditorProvider, null, createElement(Fragment, null, createElement(Fixture), createElement(AppModals))));
