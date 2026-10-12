import { createRoot } from '../../apps/web/node_modules/react-dom/client';
import { createElement, Fragment } from '../../apps/web/node_modules/react';
import MaskWorkshop from '../../apps/web/src/components/MaskWorkshop';
import AppModals from '../../apps/web/src/components/AppModals';
import type { Frame } from '@framebaker/shared';

const frames = [1, 2, 3].map(n => ({ id: `frame-${n}` })) as Frame[];
createRoot(document.getElementById('root')!).render(createElement(Fragment, null,
  createElement('button', { className: 'px-btn accent-cyan', id: 'hover-target' }, '场景抠图与修正'),
  createElement('button', { className: 'px-btn', id: 'plain-target' }, '普通按钮'),
  createElement(MaskWorkshop, { projectId: 'fixture', frames, initialId: frames[0]!.id, onChanged: ()=>{}, onClose: ()=>{} }),
  createElement(AppModals),
));
