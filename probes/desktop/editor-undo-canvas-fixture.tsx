import { createRoot } from '../../apps/web/node_modules/react-dom/client';
import { createElement, Fragment } from '../../apps/web/node_modules/react';
import * as PIXI from '../../apps/web/node_modules/pixi.js';
import AppModals from '../../apps/web/src/components/AppModals';

// Exercise the real Editor and WebGL renderer; only the HTTP data is synthetic.
const fixture = window as any;
fixture.fixtureEvents = [];
fixture.fixtureErrors = [];
const applications: PIXI.Application[] = [];
function textureInfo(texture: any) {
  if (!texture) return null;
  return {
    empty: texture === PIXI.Texture.EMPTY,
    uid: texture.uid,
    destroyed: texture.destroyed,
    source: texture.source ? { uid: texture.source.uid, destroyed: texture.source.destroyed } : null,
  };
}
const originalLoad = PIXI.Assets.load.bind(PIXI.Assets);
const originalUnload = PIXI.Assets.unload.bind(PIXI.Assets);
(PIXI.Assets as any).load = (...args: any[]) => {
  fixture.fixtureEvents.push({ type: 'load-start', key: args[0], at: performance.now() });
  return originalLoad(...args).then((texture: any) => {
    fixture.fixtureEvents.push({ type: 'load-complete', key: args[0], at: performance.now(), texture: textureInfo(texture) });
    return texture;
  });
};
(PIXI.Assets as any).unload = async (...args: any[]) => {
  const texture = PIXI.Assets.get(args[0]);
  fixture.fixtureEvents.push({ type: 'unload-start', key: args[0], at: performance.now(), texture: textureInfo(texture) });
  const result = await originalUnload(...args);
  fixture.fixtureEvents.push({ type: 'unload-complete', key: args[0], at: performance.now(), texture: textureInfo(texture) });
  return result;
};
window.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'z') fixture.fixtureEvents.push({ type: 'undo-key', trusted: event.isTrusted, at: performance.now() });
}, true);
window.addEventListener('error', event => fixture.fixtureErrors.push({ kind: 'window.error', message: event.message, stack: event.error?.stack }));
window.addEventListener('unhandledrejection', event => fixture.fixtureErrors.push({ kind: 'unhandledrejection', message: String(event.reason), stack: event.reason?.stack }));
class ObservedApplication extends PIXI.Application {
  constructor() { super(); applications.push(this); }
}
fixture.PIXI = { ...PIXI, Application: ObservedApplication };
fixture.fixtureState = () => {
  const canvas = document.querySelector<HTMLCanvasElement>('.pixi-wrap canvas');
  const rect = canvas?.getBoundingClientRect();
  const summarize = (node: any): any => ({
    type: node.constructor.name,
    visible: node.visible,
    texture: textureInfo(node.texture),
    children: node.children?.map(summarize) ?? [],
  });
  return {
    errors: fixture.fixtureErrors,
    events: fixture.fixtureEvents,
    viewport: { width: innerWidth, height: innerHeight },
    canvas: canvas && rect ? { width: canvas.width, height: canvas.height, connected: canvas.isConnected, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : null,
    applications: applications.map(app => ({
      canvasConnected: !!app.renderer?.canvas?.isConnected,
      contextLost: (app.renderer as any)?.gl?.isContextLost?.() ?? false,
      stage: summarize(app.stage),
    })),
  };
};
const { default: Editor } = await import('../../apps/web/src/components/Editor');
createRoot(document.getElementById('root')!).render(createElement(Fragment, null,
  createElement(Editor, { projectId: 'fixture', onBack: () => {} }),
  createElement(AppModals),
));
