import { expect, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import path from 'node:path';

export const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name);

/** Both map fixtures are 1400x700 px; the default grid has 70 px cells (20 x 10). */
export const MAP = { width: 1400, height: 700, cell: 70 };

/** Screen position of an image pixel while the map is shown fitted (the initial view). */
export async function mapPoint(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = await page.locator('.map-canvas').boundingBox();
  if (!box) throw new Error('no map on the page');
  const scale = Math.min(box.width / MAP.width, box.height / MAP.height) * 0.95;
  return [
    box.x + (box.width - MAP.width * scale) / 2 + x * scale,
    box.y + (box.height - MAP.height * scale) / 2 + y * scale,
  ];
}

/** Centre of a grid cell (1-based column and row, as shown to people). */
export const cell = (col: number, row: number): [number, number] => [
  (col - 0.5) * MAP.cell,
  (row - 0.5) * MAP.cell,
];

export async function clickMap(page: Page, [x, y]: [number, number]) {
  await page.mouse.click(...(await mapPoint(page, x, y)));
}

export async function dragOnMap(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...(await mapPoint(page, ...from)));
  await page.mouse.down();
  await page.mouse.move(...(await mapPoint(page, ...to)), { steps: 12 });
  await page.mouse.up();
}

/** The accessible list of tokens next to the canvas: "Гоблин 1, клетка 6, 6". */
export const tokensOn = (page: Page) =>
  page.getByRole('list', { name: 'Фишки на карте' }).getByRole('listitem');

export async function waitForMap(page: Page) {
  await expect(page.locator('.map-canvas canvas').first()).toBeVisible();
  await expect(page.locator('.map-status')).toHaveCount(0);
}

export async function createSessionAsMaster(page: Page, name = 'Мастер'): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Создать сессию' }).click();
  await expect(page).toHaveURL(/\/s\/[A-Z2-9]{8}$/);
  await expect(page.locator('.badge')).toHaveText('На связи');
  return page.url();
}

export async function uploadMap(page: Page, file: string) {
  const before = await page.locator('.map-list li').count();
  await page.locator('input[type=file]').first().setInputFiles(fixture(file));
  await expect(page.locator('.map-list li')).toHaveCount(before + 1);
  await waitForMap(page);
}

export async function joinAsPlayer(
  browser: Browser,
  inviteUrl: string,
  name: string,
  options: BrowserContextOptions = {},
  /** Runs before the page opens, e.g. to start recording its websocket traffic. */
  beforeOpen: (page: Page) => void = () => {},
): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  beforeOpen(page);
  await page.goto(inviteUrl);
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.locator('.badge')).toHaveText('На связи');
  return page;
}

/** Everything the server sends to a page over its websocket, as text. */
export function recordServerTraffic(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) =>
      frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString()),
    ),
  );
  return frames;
}

/** Everything a page sends to the server over its websocket, as text. */
export function recordClientTraffic(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) =>
      frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString()),
    ),
  );
  return frames;
}

/** The accessible list of obstacles next to the canvas: "Стена, клетки 6 × 1–10". */
export const obstaclesOn = (page: Page) =>
  page.getByRole('list', { name: 'Препятствия' }).getByRole('listitem');

/** The master's obstacle tool buttons (wall, pillar, barrel, eraser). */
export const tool = (page: Page, name: 'Стена' | 'Столб' | 'Бочка' | 'Ластик') =>
  page.getByRole('group', { name: 'Инструмент' }).getByRole('button', { name });
