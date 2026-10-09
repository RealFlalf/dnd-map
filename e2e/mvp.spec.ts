/**
 * The MVP acceptance criteria (requirements, section 11) and use cases UC-1…UC-4, played through
 * real browsers against the production build. Every test starts its own session.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  cell,
  clickMap,
  createSessionAsMaster,
  dragOnMap,
  fixture,
  joinAsPlayer,
  mapPoint,
  recordClientTraffic,
  recordServerTraffic,
  tokensOn,
  uploadMap,
  waitForMap,
} from './helpers';

const gridValue = async (page: Page, label: string) =>
  Number(
    (
      await page
        .locator('.slider-field', { hasText: label })
        .locator('input[type=number]')
        .inputValue()
    ).replace(',', '.'),
  );

/** Distance of a value from the nearest multiple of `step` (grid offsets wrap around a cell). */
const offGrid = (value: number, step: number) => Math.min(value % step, step - (value % step));

async function placeMonster(master: Page, name: string, at: [number, number], hidden = false) {
  const hiddenBox = master.locator('label.check', { hasText: 'скрытыми' }).locator('input');
  if ((await hiddenBox.isChecked()) !== hidden) await hiddenBox.click();
  await master.locator('.palette-item', { hasText: name }).click();
  const count = await tokensOn(master).count();
  await clickMap(master, at);
  await expect(tokensOn(master)).toHaveCount(count + 1);
  await master.keyboard.press('Escape');
}

test('UC-1: the master creates a session, uploads a map and fits the grid to it', async ({
  page,
}) => {
  await createSessionAsMaster(page);
  await expect(page.getByText('Загрузите изображение карты')).toBeVisible();

  await uploadMap(page, 'dungeon.png');

  // Spoil the grid, then fit it again by tracing one cell of the picture (lines every 70 px).
  const scaleBox = page
    .locator('.slider-field', { hasText: 'Размер клетки' })
    .locator('input[type=number]');
  await scaleBox.fill('50');
  await scaleBox.press('Enter');
  await page.getByRole('button', { name: 'Подогнать по клетке' }).click();
  await dragOnMap(page, [140, 70], [210, 140]);

  await expect.poll(() => gridValue(page, 'Размер клетки')).toBeGreaterThan(67);
  expect(await gridValue(page, 'Размер клетки')).toBeLessThan(73);
  expect(offGrid(await gridValue(page, 'Смещение по X'), 70)).toBeLessThan(3);
  expect(offGrid(await gridValue(page, 'Смещение по Y'), 70)).toBeLessThan(3);

  await page.getByLabel('Показывать сетку').uncheck();
  await page.reload();
  await waitForMap(page);
  expect(Math.abs((await gridValue(page, 'Размер клетки')) - 70)).toBeLessThan(3);
  await expect(page.getByLabel('Показывать сетку')).not.toBeChecked();
  await expect(page.getByText('Вы — Мастер, Мастер')).toBeVisible();
});

test('UC-2: a player joins by link and controls only their own character', async ({
  page: master,
  browser,
}) => {
  const inviteUrl = await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  await placeMonster(master, 'Гоблин', cell(10, 3));

  const alice = await joinAsPlayer(browser, inviteUrl, 'Алиса');
  await waitForMap(alice);
  await expect(alice.getByText('Вы — Алиса, Игрок')).toBeVisible();
  await expect(alice.locator('.palette')).toHaveCount(0); // no master controls
  await expect(alice.locator('input[type=file]')).toHaveCount(1); // only her own icon upload

  await alice.getByRole('button', { name: 'Волшебник' }).click();
  await alice.getByRole('button', { name: 'Поставить на карту' }).click();
  await clickMap(alice, cell(4, 5));
  await expect(tokensOn(master).filter({ hasText: 'Алиса' })).toHaveText('Алиса, клетка 4, 5');

  // her own character: moves for everyone
  await dragOnMap(alice, cell(4, 5), cell(8, 7));
  await expect(tokensOn(master).filter({ hasText: 'Алиса' })).toHaveText('Алиса, клетка 8, 7');

  // somebody else's tokens: nothing happens, for her or for anyone
  await dragOnMap(alice, cell(10, 3), cell(15, 8));
  await dragOnMap(master, cell(8, 7), cell(2, 2));
  await alice.waitForTimeout(500);
  await expect(tokensOn(master).filter({ hasText: 'Гоблин' })).toHaveText('Гоблин 1, клетка 10, 3');
  await expect(tokensOn(alice).filter({ hasText: 'Алиса' })).toHaveText('Алиса, клетка 8, 7');

  // a reload brings her back as herself, still owning the character
  await alice.reload();
  await waitForMap(alice);
  await expect(alice.getByRole('button', { name: 'Убрать с карты' })).toBeVisible();
  await dragOnMap(alice, cell(8, 7), cell(9, 7));
  await expect(tokensOn(master).filter({ hasText: 'Алиса' })).toHaveText('Алиса, клетка 9, 7');
  await expect(master.locator('.participants li')).toHaveCount(2);
});

test('UC-3: the master runs a fight and the players see it; hidden monsters stay hidden', async ({
  page: master,
  browser,
}) => {
  const inviteUrl = await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  // Recording has to start before the page connects, or it sees nothing at all.
  let bobTraffic: string[] = [];
  const bob = await joinAsPlayer(browser, inviteUrl, 'Боб', {}, (page) => {
    bobTraffic = recordServerTraffic(page);
  });
  await waitForMap(bob);

  await placeMonster(master, 'Орк', cell(5, 5));
  await placeMonster(master, 'Скелет', cell(6, 5));
  await expect(tokensOn(bob)).toHaveText(['Орк 1, клетка 5, 5', 'Скелет 1, клетка 6, 5']);

  // a move reaches the player quickly (the 300 ms budget itself is measured in the server tests)
  const startedAt = Date.now();
  await dragOnMap(master, cell(5, 5), cell(12, 6));
  await expect(tokensOn(bob).first()).toHaveText('Орк 1, клетка 12, 6');
  test.info().annotations.push({
    type: 'move seen by the player after',
    description: `${Date.now() - startedAt} ms`,
  });

  // an ambush: placed hidden, moved around, never seen by the player
  await placeMonster(master, 'Дракон', cell(18, 2), true);
  await dragOnMap(master, cell(18, 2), cell(17, 3));
  await expect(tokensOn(master).filter({ hasText: 'Дракон' })).toHaveText(
    'Дракон 1, клетка 17, 3 (скрыт от игроков)',
  );
  await bob.waitForTimeout(500);
  await expect(tokensOn(bob)).toHaveCount(2);
  expect(bobTraffic.join('\n')).toContain('Скелет'); // the recording does capture token traffic
  expect(bobTraffic.join('\n')).not.toMatch(/Дракон|dragon/);

  // revealed at the right moment
  await master.getByRole('button', { name: 'Показать: Дракон 1' }).click();
  await expect(tokensOn(bob).filter({ hasText: 'Дракон' })).toHaveText('Дракон 1, клетка 17, 3');

  // the skeleton is slain
  await master.getByRole('button', { name: 'Удалить: Скелет 1' }).click();
  await expect(tokensOn(bob)).toHaveText(['Орк 1, клетка 12, 6', 'Дракон 1, клетка 17, 3']);
});

test('UC-4: a new location starts empty and the old one is kept', async ({
  page: master,
  browser,
}) => {
  const inviteUrl = await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  const alice = await joinAsPlayer(browser, inviteUrl, 'Алиса');
  await waitForMap(alice);
  await placeMonster(master, 'Волк', cell(3, 3));
  await alice.getByRole('button', { name: 'Поставить на карту' }).click();
  await clickMap(alice, cell(4, 3));
  await expect(tokensOn(alice)).toHaveCount(2);

  await uploadMap(master, 'forest.png');
  await expect(tokensOn(alice)).toHaveCount(0);
  await expect(alice.getByRole('button', { name: 'Поставить на карту' })).toBeVisible();
  await alice.getByRole('button', { name: 'Поставить на карту' }).click();
  await clickMap(alice, cell(1, 1));
  await expect(tokensOn(master)).toHaveText(['Алиса, клетка 1, 1']);

  await master.locator('.map-pick', { hasText: 'Карта 1' }).click();
  await expect(tokensOn(alice)).toHaveText(['Волк 1, клетка 3, 3', 'Алиса, клетка 4, 3']);
});

test('a custom character icon reaches the other participants', async ({
  page: master,
  browser,
}) => {
  const inviteUrl = await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  const alice = await joinAsPlayer(browser, inviteUrl, 'Алиса');
  await alice.locator('input[type=file]').setInputFiles(fixture('portrait.png'));
  await expect(
    master.locator('.participants li', { hasText: 'Алиса' }).locator('img.token-icon'),
  ).toHaveAttribute('src', /\/api\/files\/[0-9a-f-]{36}\.icon\.webp$/);
});

test('on a phone a player can place and move their character with a finger', async ({
  page: master,
  browser,
}) => {
  const inviteUrl = await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  let sent: string[] = [];
  const phone = await joinAsPlayer(
    browser,
    inviteUrl,
    'Сэм',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
    (page) => {
      sent = recordClientTraffic(page);
    },
  );
  await waitForMap(phone);
  expect(
    await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  await phone.getByRole('button', { name: 'Поставить на карту' }).tap();
  await expect(phone.locator('.sidebar.open')).toHaveCount(0); // the sheet folds away for placing
  // The map grew when the sheet folded; fit it again so that the helper's geometry applies.
  await phone.getByRole('button', { name: 'Вписать карту в экран' }).tap();
  const [x, y] = await mapPoint(phone, ...cell(5, 5));
  await phone.touchscreen.tap(x, y);
  await expect(tokensOn(master)).toHaveText(['Сэм, клетка 5, 5']);
  await phone.waitForTimeout(500);
  await expect(tokensOn(master)).toHaveCount(1); // one tap, one character
  // ...and only one request: on touch screens a tap also produces a click
  expect(sent.filter((f) => f.includes('"character.place"'))).toHaveLength(1);

  const cdp = await phone.context().newCDPSession(phone);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<[number, number]>) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([px, py], id) => ({ x: px, y: py, id })),
    });
  const [tx, ty] = await mapPoint(phone, ...cell(9, 6));
  await touch('touchStart', [[x, y]]);
  for (let i = 1; i <= 10; i++)
    await touch('touchMove', [[x + ((tx - x) * i) / 10, y + ((ty - y) * i) / 10]]);
  await touch('touchEnd', []);
  await expect(tokensOn(master)).toHaveText(['Сэм, клетка 9, 6']);
});
