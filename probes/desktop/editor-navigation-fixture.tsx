import { createRoot } from '../../apps/web/node_modules/react-dom/client';
import { createElement, Fragment } from '../../apps/web/node_modules/react';
import * as PIXI from '../../apps/web/node_modules/pixi.js';
import AppModals from '../../apps/web/src/components/AppModals';
import { askConfirm } from '../../apps/web/src/notice';

// 运行真实编辑器与 Pixi；网络仅指向本探针的合成数据。
(window as any).PIXI = PIXI;
(window as any).fixtureConfirm = () => askConfirm('导航确认探针');
const { default: Editor } = await import('../../apps/web/src/components/Editor');
createRoot(document.getElementById('root')!).render(createElement(Fragment, null,
  createElement(Editor, { projectId: 'fixture', onBack: () => {} }),
  createElement(AppModals),
));
