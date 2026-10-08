"""Initial-match recovery (#11) and header/account layout (#10) in real Chromium over normal navigation.
Start the server first on a scratch database with an empty TYPESAFE_API_KEY (see docs/TESTING.md), then:
  TEST_ORIGIN=http://127.0.0.1:18842 DATABASE_PATH=/scratch/ttt.sqlite OUT=/evidence/dir python3 tests/browser-boot.py
Failure injection uses page.route on this app's own /api paths only; no provider is involved."""
import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from playwright.async_api import async_playwright
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = os.environ.get('TEST_ORIGIN', 'http://127.0.0.1:18842')
DB = os.environ.get('DATABASE_PATH')
OUT = Path(os.environ.get('OUT', ROOT / 'reports' / 'browser-boot'))
OUT.mkdir(parents=True, exist_ok=True)
HOST = ORIGIN.split('//')[1].split(':')[0]
COOKIE = 'jev_dev_session'
results = []


def check(name, ok, detail=''):
    results.append({'name': name, 'ok': bool(ok), 'detail': str(detail)})
    print(('ok   ' if ok else 'FAIL ') + name + (f'  {detail}' if detail and not ok else ''), flush=True)


def seed(name):
    out = subprocess.run(['node', str(ROOT / 'tests' / 'seed-session.js'), name], capture_output=True, text=True, env={**os.environ, 'DATABASE_PATH': DB}, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])['token']


def me(page):
    return page.evaluate("() => fetch('/api/me', {credentials: 'same-origin'}).then(r => r.json())")


def ready(page):
    page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)


def new_context(browser, token=None, viewport=None):
    context = browser.new_context(viewport=viewport or {'width': 1280, 'height': 900}, reduced_motion='reduce')
    if token:
        context.add_cookies([{'name': COOKIE, 'value': token, 'domain': HOST, 'path': '/', 'httpOnly': True, 'sameSite': 'Lax'}])
    return context


def boot_flows(browser, label, token):
    context = new_context(browser, token)
    page = context.new_page()
    errors, creates = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: creates.append(r.url) if r.method == 'POST' and r.url.endswith('/api/matches') else None)
    page.goto(ORIGIN)
    ready(page)
    first = me(page)['activeMatchId']
    check(f'{label}: first load creates one playable match', first and len(creates) == 1, creates)
    page.locator('#board button').nth(4).click()
    page.locator('#board button[aria-label$=", X"]').first.wait_for()
    for i in range(3):
        page.reload()
        page.locator('#board button[aria-label$=", X"]').first.wait_for(timeout=15000)
    check(f'{label}: reload x3 restores same match, board and no extra create', me(page)['activeMatchId'] == first and len(creates) == 1, creates)
    check(f'{label}: New game and Reconnect remain', page.locator('#new-game').is_enabled() and page.locator('#reconnect').is_visible())

    # Connection failure on /api/me: visible error, Retry, no create, no local game, then recovery to the same match.
    page.route('**/api/me', lambda route: route.abort())
    before = len(creates)
    page.reload()
    page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
    check(f'{label}: /api/me failure shows error state', 'Could not' in page.locator('#game-status').inner_text() and page.locator('#new-game').is_disabled())
    check(f'{label}: failure creates nothing and starts no local game', len(creates) == before and 'LOCAL' not in page.locator('#mode-badge').inner_text())
    page.unroute('**/api/me')
    page.locator('#boot-retry').click()
    ready(page)
    check(f'{label}: Retry restores the same match', me(page)['activeMatchId'] == first and len(creates) == before)

    # Server failure while loading the prior match.
    page.route('**/api/matches/*', lambda route: route.fulfill(status=500, content_type='application/json', body='{"error":"internal"}') if route.request.method == 'GET' else route.continue_())
    page.reload()
    page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
    check(f'{label}: prior-match 500 shows retry and creates nothing', len(creates) == before)
    page.unroute('**/api/matches/*')
    page.locator('#boot-retry').click()
    ready(page)
    check(f'{label}: Retry after 500 restores the same match', me(page)['activeMatchId'] == first and len(creates) == before)
    check(f'{label}: no page errors', not errors, errors)

    # Resign (ended match), then reload yields exactly one new playable match.
    page.once('dialog', lambda d: d.accept())
    page.locator('#resign').click()
    page.locator('#game-status', has_text='resigned').wait_for(timeout=15000)
    page.reload()
    ready(page)
    second = me(page)['activeMatchId']
    check(f'{label}: ended match is replaced by a new playable match', second and second != first)
    page.reload()
    ready(page)
    check(f'{label}: and that one is stable across reload', me(page)['activeMatchId'] == second)

    # Explicit local practice when the service is down and nothing is on screen.
    fresh = new_context(browser, token)
    local = fresh.new_page()
    local.route('**/api/me', lambda route: route.abort())
    local.goto(ORIGIN)
    local.locator('#boot-local').wait_for(state='visible', timeout=15000)
    local.locator('#boot-local').click()
    local.locator('#mode-badge', has_text='LOCAL PRACTICE').wait_for(timeout=15000)
    check(f'{label}: explicit local practice is labeled local', True)
    fresh.close()
    context.close()


def tabs(browser):
    context = new_context(browser)
    a, b = context.new_page(), context.new_page()
    a.goto(ORIGIN)
    ready(a)
    b.goto(ORIGIN)
    ready(b)
    ids = {me(a)['activeMatchId'], me(b)['activeMatchId']}
    check('two tabs of one browser share one match', len(ids) == 1, ids)
    context.close()


NO_LOCKS = "Object.defineProperty(navigator, 'locks', {value: undefined, configurable: true})"


async def a_me(page):
    return await page.evaluate("() => fetch('/api/me', {credentials: 'same-origin'}).then(r => r.json())")


async def settle(page, pattern):
    try:
        await page.locator('#game-status', has_text=pattern).wait_for(timeout=20000)
        return True
    except Exception:
        return False


async def overlap_suite(launch_kwargs):
    """Genuinely overlapping initialisation: several pages of one browser boot at once. Without Web Locks every page's
    create is held at a barrier until all have arrived, so the server sees them simultaneously."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(**launch_kwargs)
        scenarios = [
            ('guest', None, True, False),
            ('guest', None, False, True),
            ('guest', None, False, False),
            ('signed-in', seed('Overlap Player') if DB else None, False, True),
        ]
        for label, token, locks, warm in scenarios:
            if label == 'signed-in' and not DB:
                continue
            jar = 'session cookie already present' if token or warm else 'cold cookie jar'
            tag = f'overlap {label} {"with" if locks else "without"} Web Locks, {jar}'
            context = await browser.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
            if token:
                await context.add_cookies([{'name': COOKIE, 'value': token, 'domain': HOST, 'path': '/', 'httpOnly': True, 'sameSite': 'Lax'}])
            if not locks:
                await context.add_init_script(NO_LOCKS)
            if warm and label == 'guest' and not locks:
                await context.request.get(ORIGIN + '/api/me')
            count, arrived, outcomes = 4, [], []
            released = asyncio.Event()
            context.on('response', lambda r: outcomes.append((r.status, r.url.split('/api/')[-1])) if r.request.method == 'POST' and r.url.endswith('/api/matches') else None)

            async def hold(route):
                if route.request.method != 'POST' or locks:
                    await route.continue_()
                    return
                arrived.append(1)
                if len(arrived) >= count:
                    released.set()
                try:
                    await asyncio.wait_for(released.wait(), 5)
                except asyncio.TimeoutError:
                    pass
                await route.continue_()

            await context.route('**/api/matches', hold)
            pages = [await context.new_page() for _ in range(count)]
            errors = []
            for page in pages:
                page.on('pageerror', lambda e: errors.append(str(e)))
            await asyncio.gather(*[page.goto(ORIGIN, wait_until='commit') for page in pages])
            strict = locks or warm
            # Cold jar, no Web Locks: every page mints its own guest session and keeps only its own CSRF token, while the
            # browser keeps one cookie. Pages whose token no longer matches show the error state with Retry, which is
            # recoverable; what must never happen is a second match, a local fallback, or a page left loading.
            first_pattern = 'Your turn' if strict else re.compile('Your turn|Could not')
            settled = await asyncio.gather(*[settle(page, first_pattern) for page in pages])
            states = [await page.locator('#game-status').inner_text() for page in pages]
            diag = {'posts': outcomes, 'states': states, 'errors': errors}
            check(f'{tag}: every page settles (match or Retry) and none stays loading', all(settled), diag)
            if not strict:
                needs_retry = [page for page, text in zip(pages, states) if 'Could not' in text]
                diag['retried'] = len(needs_retry)
                check(f'{tag}: pages that lost the race show Retry, not a local game', all([await page.locator('#boot-retry').is_visible() and 'LOCAL' not in await page.locator('#mode-badge').inner_text() for page in needs_retry]), diag)
                for page in needs_retry:
                    await page.locator('#boot-retry').click()
                recovered = await asyncio.gather(*[settle(page, 'Your turn') for page in pages])
                check(f'{tag}: Retry brings every page to the match', all(recovered), diag)
            ids = {(await a_me(page))['activeMatchId'] for page in pages}
            check(f'{tag}: all {count} pages show one match', len(ids) == 1, diag)
            created = [o for o in outcomes if 200 <= o[0] < 300]
            check(f'{tag}: the server created at most one match', len(created) <= 1, diag)
            if not locks:
                check(f'{tag}: creates really overlapped at the server', len(arrived) == count, diag)
            check(f'{tag}: no page is in an error state', all([await page.locator('#boot-actions').is_hidden() for page in pages]) and not errors, diag)
            (OUT / f'overlap-{label}-{"locks" if locks else "nolocks"}-{"warm" if warm else "cold"}.json').write_text(json.dumps({'tag': tag, **diag}, indent=2) + '\n')
            await context.close()

        # Loader, error and Retry, observed while they are on screen.
        token = seed('Loader Player') if DB else None
        context = await browser.new_context(viewport={'width': 390, 'height': 844}, reduced_motion='reduce')
        if token:
            await context.add_cookies([{'name': COOKIE, 'value': token, 'domain': HOST, 'path': '/', 'httpOnly': True, 'sameSite': 'Lax'}])
        page = await context.new_page()
        gate = asyncio.Event()

        async def slow_me(route):
            await gate.wait()
            await route.continue_()

        await page.route('**/api/me', slow_me)
        await page.goto(ORIGIN, wait_until='commit')
        await page.locator('#game-status', has_text='Loading your game').wait_for(timeout=10000)
        check('loader: visible while /api/me is pending', True)
        check('loader: New game disabled while loading', await page.locator('#new-game').is_disabled())
        gate.set()
        await page.unroute('**/api/me')
        await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
        first = (await a_me(page))['activeMatchId']
        await page.locator('#board button').nth(4).click()
        await page.locator('#board button[aria-label$=", X"]').first.wait_for()

        failing = {'on': True}
        retry_gate = asyncio.Event()

        async def flaky(route):
            if route.request.method == 'GET' and failing['on']:
                await route.fulfill(status=503, content_type='application/json', body='{"error":"unavailable"}')
            elif route.request.method == 'GET':
                await retry_gate.wait()
                await route.continue_()
            else:
                await route.continue_()

        await page.route('**/api/matches/*', flaky)
        await page.reload()
        await page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
        check('error: shown with Retry and the page offers no replacement match', await page.locator('#boot-retry').is_visible() and await page.locator('#new-game').is_disabled())
        failing['on'] = False
        await page.locator('#boot-retry').click()
        await page.locator('#game-status', has_text='Loading your game').wait_for(timeout=10000)
        check('retry: loading state is shown again while the retry is in flight', await page.locator('#boot-actions').is_hidden())
        retry_gate.set()
        await page.unroute('**/api/matches/*')
        await page.locator('#board button[aria-label$=", X"]').first.wait_for(timeout=15000)
        check('retry: restores the same match with its move', (await a_me(page))['activeMatchId'] == first)
        await context.close()
        await browser.close()


WIDTHS = [(320, 568), (390, 844), (768, 1024), (899, 800), (900, 800), (1000, 800), (1099, 800), (1100, 800), (1280, 720), (1920, 1080)]


def layout(browser, label, token, name):
    for width, height in WIDTHS:
        context = new_context(browser, token, {'width': width, 'height': height})
        page = context.new_page()
        page.goto(ORIGIN)
        ready(page)
        desktop = width >= 900
        if not desktop:
            page.locator('#jv-menu').click()
        info = page.evaluate("""() => {
          const box = e => { const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom}; };
          const c = document.getElementById('jv-controls'), header = document.querySelector('.jv-header');
          const items = [...document.querySelectorAll('#jv-controls a, #jv-controls button')].filter(e => e.getClientRects().length).map(e => ({id: e.id || e.textContent.trim(), ...box(e)}));
          const idEl = document.getElementById('identity-name');
          const parts = [...document.querySelectorAll('#jv-controls a, #jv-controls button, #identity-name')].filter(e => e.getClientRects().length)
            .map(e => ({id: e.id || e.textContent.trim(), ...box(e), clipped: e.id !== 'identity-name' && e.scrollWidth > e.clientWidth + 1}));
          return {parts, overflowX: document.documentElement.scrollWidth > innerWidth + 1, inHeader: header.contains(c), controls: box(c), controlsScroll: c.scrollWidth > c.clientWidth + 1, items,
                  identity: (document.getElementById('identity-name') || {}).getBoundingClientRect ? box(document.getElementById('identity-name')) : null};
        }""")
        small = [i for i in info['items'] if i['h'] < 43.5 or i['w'] < 43.5]
        tag = f'{label} {width}x{height}'
        check(f'#10 {tag}: no horizontal page overflow', not info['overflowX'])
        check(f'#10 {tag}: controls {"in header" if desktop else "in sheet"}', info['inHeader'] == desktop)
        check(f'#10 {tag}: header/sheet targets >= 44px', not small, small)
        overlaps = [(a['id'], b['id']) for i, a in enumerate(info['parts']) for b in info['parts'][i + 1:]
                    if min(a['r'], b['r']) - max(a['x'], b['x']) > 1 and min(a['b'], b['b']) - max(a['y'], b['y']) > 1]
        check(f'#10 {tag}: no control or identity text overlaps another', not overlaps, overlaps)
        check(f'#10 {tag}: no control label is clipped by its own box', not [i['id'] for i in info['parts'] if i['clipped']], [i['id'] for i in info['parts'] if i['clipped']])
        action = '#logout' if token else '#login'
        if page.locator(action).is_visible():
            ident = info['identity']
            btn = page.locator(action).bounding_box()
            if desktop and ident and ident['w'] > 0:
                check(f'#10 {tag}: identity and account action share a row', abs((ident['y'] + ident['h'] / 2) - (btn['y'] + btn['height'] / 2)) < 12, (ident, btn))
            if desktop:
                check(f'#10 {tag}: account action fully inside the controls box without scrolling', btn['x'] >= info['controls']['x'] - 1 and btn['x'] + btn['width'] <= info['controls']['r'] + 1, (btn, info['controls']))
            page.locator(action).focus()
            page.keyboard.press('Shift+Tab')
            page.keyboard.press('Tab')
            ring = page.evaluate("() => { const s = getComputedStyle(document.activeElement); return {outline: s.outlineStyle, w: parseFloat(s.outlineWidth), shadow: s.boxShadow}; }")
            check(f'#10 {tag}: keyboard focus ring visible on account action', (ring['outline'] != 'none' and ring['w'] > 0) or ring['shadow'] != 'none', ring)
        page.screenshot(path=str(OUT / f'layout-{label.replace(" ", "-")}-{width}x{height}.png'))
        context.close()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None, headless=True, args=['--no-sandbox'])
    boot_flows(browser, 'guest', None)
    tabs(browser)
    if DB:
        boot_flows(browser, 'signed-in', seed('Fixture Player'))
        layout(browser, 'signed-in', seed('Fixture Player Layout'), 'Fixture Player Layout')
        layout(browser, 'signed-in long name', seed('Alexandria Konstantinopolous-Featherstonehaugh'), 'long')
    else:
        check('signed-in checks skipped: DATABASE_PATH not set', False)
    layout(browser, 'signed-out', None, None)
    browser.close()

asyncio.run(overlap_suite({'executable_path': os.environ.get('CHROMIUM_PATH') or None, 'headless': True, 'args': ['--no-sandbox']}))

(OUT / 'browser-boot.json').write_text(json.dumps({'origin': ORIGIN, 'results': results}, indent=2) + '\n')
failed = [r for r in results if not r['ok']]
print(f'{len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
