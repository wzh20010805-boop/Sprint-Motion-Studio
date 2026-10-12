import { createRoot } from '../../apps/web/node_modules/react-dom/client';
import { createElement, Fragment } from '../../apps/web/node_modules/react';
import MaterialsPage from '../../apps/web/src/components/MaterialsPage';
import { MaterialEditorProvider } from '../../apps/web/src/components/MaterialEditor';
import AppModals from '../../apps/web/src/components/AppModals';
import { wsClient } from '../../apps/web/src/api';

// 渲染实际产品组件，HTTP 由同目录隔离探针提供，不访问用户工作区。
wsClient.start();
createRoot(document.getElementById('root')!).render(createElement(MaterialEditorProvider, null,
  createElement(Fragment, null, createElement(MaterialsPage), createElement(AppModals))));
