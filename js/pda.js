import { selectPdaModule } from './modeRouter.js?v=20260921b';

const moduleName = selectPdaModule(window.location.search);
await import(`./${moduleName}?v=20260921b`);
