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
  obstaclesOn,
  mapPoint,
  recordClientTraffic,
  recordServerTraffic,
  tokensOn,
  tool,
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

  // the master's monster is not hers to move
  await dragOnMap(alice, cell(10, 3), cell(15, 8));
  await alice.waitForTimeout(500);
  await expect(tokensOn(master).filter({ hasText: 'Гоблин' })).toHaveText('Гоблин 1, клетка 10, 3');

  // the master may move her character, and she is told about it
  await dragOnMap(master, cell(8, 7), cell(2, 2));
  await expect(tokensOn(alice).filter({ hasText: 'Алиса' })).toHaveText('Алиса, клетка 2, 2');
  await expect(alice.getByText('Мастер переместил вашего персонажа')).toBeVisible();

  // a reload brings her back as herself, still owning the character
  await alice.reload();
  await waitForMap(alice);
  await expect(alice.getByRole('button', { name: 'Убрать с карты' })).toBeVisible();
  await dragOnMap(alice, cell(2, 2), cell(3, 2));
  await expect(tokensOn(master).filter({ hasText: 'Алиса' })).toHaveText('Алиса, клетка 3, 2');
  await expect(master.locator('.participants li')).toHaveCount(2);
});

test('the master puts players on the map, moves and removes them', async ({
  page: master,
  browser,
}) => {
  const inviteUrl = await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  const alice = await joinAsPlayer(browser, inviteUrl, 'Алиса');
  const bob = await joinAsPlayer(browser, inviteUrl, 'Боб');
  await waitForMap(alice);
  await waitForMap(bob);

  // both players are waiting for the master to place them
  const waiting = master.locator('.panel', { hasText: 'Игроки без персонажа' });
  await expect(waiting.locator('li')).toHaveCount(2);
  await waiting
    .locator('li', { hasText: 'Боб' })
    .getByRole('button', { name: 'Поставить' })
    .click();
  await expect(master.getByText('поставить персонажа «Боб»')).toBeVisible();
  await clickMap(master, cell(6, 4));

  await expect(tokensOn(bob)).toHaveText(['Боб, клетка 6, 4']);
  await expect(bob.getByText('Мастер поставил вашего персонажа на карту')).toBeVisible();
  await expect(waiting.locator('li')).toHaveCount(1); // only Алиса is left
  await expect(master.getByText('поставить персонажа')).toHaveCount(0); // placing mode ended

  // Боб carries on by himself from where the master put him
  await dragOnMap(bob, cell(6, 4), cell(7, 4));
  await expect(tokensOn(master)).toHaveText(['Боб, клетка 7, 4']);

  // the master takes him off the map again; he is waiting once more
  await master.getByRole('button', { name: 'Удалить: Боб' }).click();
  await expect(tokensOn(alice)).toHaveCount(0);
  await expect(bob.getByText('Мастер убрал вашего персонажа с карты')).toBeVisible();
  await expect(bob.getByRole('button', { name: 'Поставить на карту' })).toBeVisible();
  await expect(waiting.locator('li')).toHaveCount(2);
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

test('obstacles: the master builds walls, players cannot cross them, the master takes them down', async ({
  page: master,
  browser,
}) => {
  const inviteUrl = await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  const alice = await joinAsPlayer(browser, inviteUrl, 'Алиса');
  await waitForMap(alice);
  await alice.getByRole('button', { name: 'Поставить на карту' }).click();
  await clickMap(alice, cell(3, 5));
  await expect(tokensOn(master)).toHaveText(['Алиса, клетка 3, 5']);

  // a wall down the whole of column 6, drawn with the mouse; the players see it
  await tool(master, 'Стена').click();
  await dragOnMap(master, cell(6, 1), cell(6, 10));
  await expect(obstaclesOn(master)).toHaveText(['Стена, клетки 6 × 1–10']);
  await expect(obstaclesOn(alice)).toHaveText(['Стена, клетки 6 × 1–10']);
  await master.keyboard.press('Escape');

  // she cannot cross it, and is told why; the token stays where it was
  await dragOnMap(alice, cell(3, 5), cell(9, 5));
  await expect(alice.getByText('Туда не пройти: мешает препятствие')).toBeVisible();
  await expect(tokensOn(alice)).toHaveText(['Алиса, клетка 3, 5']);
  await expect(tokensOn(master)).toHaveText(['Алиса, клетка 3, 5']);

  // right up to the wall is fine
  await dragOnMap(alice, cell(3, 5), cell(5, 5));
  await expect(tokensOn(master)).toHaveText(['Алиса, клетка 5, 5']);

  // the master is not stopped: moves her through the wall
  await dragOnMap(master, cell(5, 5), cell(8, 5));
  await expect(tokensOn(alice)).toHaveText(['Алиса, клетка 8, 5']);
  await dragOnMap(master, cell(8, 5), cell(5, 5));
  await expect(tokensOn(alice)).toHaveText(['Алиса, клетка 5, 5']);

  // a pillar and a barrel by clicking on cells
  await tool(master, 'Столб').click();
  await clickMap(master, cell(4, 2));
  await tool(master, 'Бочка').click();
  await clickMap(master, cell(4, 3));
  await master.keyboard.press('Escape');
  await expect(obstaclesOn(alice)).toHaveText([
    'Стена, клетки 6 × 1–10',
    'Столб, клетки 4 × 2',
    'Бочка, клетки 4 × 3 (не закрывает обзор)',
  ]);
  // she cannot step onto the barrel either
  await dragOnMap(alice, cell(5, 5), cell(4, 3));
  await expect(tokensOn(master)).toHaveText(['Алиса, клетка 5, 5']);

  // the eraser takes the wall down; she can walk through the gap now
  await tool(master, 'Ластик').click();
  await clickMap(master, cell(6, 7));
  await master.keyboard.press('Escape');
  await expect(obstaclesOn(alice)).toHaveText([
    'Столб, клетки 4 × 2',
    'Бочка, клетки 4 × 3 (не закрывает обзор)',
  ]);
  await dragOnMap(alice, cell(5, 5), cell(9, 5));
  await expect(tokensOn(master)).toHaveText(['Алиса, клетка 9, 5']);

  // a selected object can be told not to hide what is behind it, and everything can be cleared at once
  await clickMap(master, cell(4, 2));
  await expect(master.getByText('Столб, клетки 4 × 2').first()).toBeVisible();
  await master.getByLabel('Закрывает обзор').uncheck();
  await expect(obstaclesOn(alice).first()).toHaveText('Столб, клетки 4 × 2 (не закрывает обзор)');
  master.once('dialog', (d) => d.accept());
  await master.getByRole('button', { name: /Убрать все/ }).click();
  await expect(obstaclesOn(alice)).toHaveCount(0);
  await expect(obstaclesOn(master)).toHaveCount(0);

  // they stay gone after a reload, and a reloaded player sees the same state
  await alice.reload();
  await waitForMap(alice);
  await expect(obstaclesOn(alice)).toHaveCount(0);
});

test('fog of war: players see only as far as their characters, not through walls; the master sees everything', async ({
  page: master,
  browser,
}) => {
  const inviteUrl = await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  let aliceTraffic: string[] = [];
  const alice = await joinAsPlayer(browser, inviteUrl, 'Алиса', {}, (page) => {
    aliceTraffic = recordServerTraffic(page);
  });
  await waitForMap(alice);
  await alice.getByRole('button', { name: 'Поставить на карту' }).click();
  await clickMap(alice, cell(3, 5));
  await expect(tokensOn(master)).toHaveText(['Алиса, клетка 3, 5']);

  await placeMonster(master, 'Орк', cell(5, 5));
  await placeMonster(master, 'Скелет', cell(15, 5));
  await expect(tokensOn(alice)).toHaveCount(3);

  // fog on, four cells of sight: the far skeleton disappears from the player's page and traffic
  await master.getByLabel('Включить туман').check();
  await master.getByRole('spinbutton', { name: 'Обзор, клеток' }).fill('4');
  await master.getByRole('spinbutton', { name: 'Обзор, клеток' }).press('Enter');
  await expect(tokensOn(alice)).toHaveText(['Алиса, клетка 3, 5', 'Орк 1, клетка 5, 5']);
  await expect(tokensOn(master)).toHaveCount(3); // the master still sees all of it
  const mark = aliceTraffic.length;
  await dragOnMap(master, cell(15, 5), cell(16, 5));
  await alice.waitForTimeout(400);
  expect(aliceTraffic.slice(mark).join('\n')).not.toContain('Скелет');

  // a wall between her and the orc hides it
  await tool(master, 'Столб').click();
  await clickMap(master, cell(4, 5));
  await master.keyboard.press('Escape');
  await expect(tokensOn(alice)).toHaveText(['Алиса, клетка 3, 5']);
  await expect(obstaclesOn(alice)).toHaveText(['Столб, клетки 4 × 5']);

  // "as players" shows the master the same thing
  await master.getByLabel('Смотреть как игроки').check();
  await expect(tokensOn(master)).toHaveText(['Алиса, клетка 3, 5']);
  await master.getByLabel('Смотреть как игроки').uncheck();
  await expect(tokensOn(master)).toHaveCount(3);

  // fog off: everything is back
  await master.getByLabel('Включить туман').uncheck();
  await expect(tokensOn(alice)).toHaveCount(3);

  // the settings survive a reload
  await master.getByLabel('Включить туман').check();
  await expect(tokensOn(alice)).toHaveText(['Алиса, клетка 3, 5']);
  await master.reload();
  await waitForMap(master);
  await expect(master.getByLabel('Включить туман')).toBeChecked();
  await expect(tokensOn(alice)).toHaveText(['Алиса, клетка 3, 5']);
});

test('master panels can be folded, and stay folded after a reload', async ({ page: master }) => {
  await createSessionAsMaster(master);
  await uploadMap(master, 'dungeon.png');
  const fogToggle = master.getByLabel('Включить туман');
  await expect(fogToggle).toBeVisible();

  await master.getByRole('button', { name: 'Туман войны' }).click();
  await expect(fogToggle).toBeHidden();
  await expect(master.getByRole('button', { name: 'Препятствия' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  await master.reload();
  await waitForMap(master);
  await expect(master.getByRole('button', { name: 'Туман войны' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await master.getByRole('button', { name: 'Туман войны' }).click();
  await expect(fogToggle).toBeVisible();
});
