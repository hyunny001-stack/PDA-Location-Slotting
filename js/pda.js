import { selectPdaModule } from './modeRouter.js?v=20260921b';

const moduleName = selectPdaModule(window.location.search);
await import(`./${moduleName}?v=20260921b`);

// Way back to the work menu (menu.html) from either scan mode; it sits outside #app so re-renders keep it.
document.body.insertAdjacentHTML('beforeend', '<a class="menu-link" href="menu.html">메뉴</a>');
