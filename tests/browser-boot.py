"""Initial-match recovery (#11) and header/account layout (#10) in real Chromium over normal navigation.
Start the server first on a scratch database with an empty TYPESAFE_API_KEY (see docs/TESTING.md), then:
  TEST_ORIGIN=http://127.0.0.1:18842 DATABASE_PATH=/scratch/ttt.sqlite OUT=/evidence/dir python3 tests/browser-boot.py
Failure injection uses page.route on this app's own /api paths only; no provider is involved."""
import json
import os
import subprocess
import sys
from pathlib import Path
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
          return {overflowX: document.documentElement.scrollWidth > innerWidth + 1, inHeader: header.contains(c), controls: box(c), controlsScroll: c.scrollWidth > c.clientWidth + 1, items,
                  identity: (document.getElementById('identity-name') || {}).getBoundingClientRect ? box(document.getElementById('identity-name')) : null};
        }""")
        small = [i for i in info['items'] if i['h'] < 43.5 or i['w'] < 43.5]
        tag = f'{label} {width}x{height}'
        check(f'#10 {tag}: no horizontal page overflow', not info['overflowX'])
        check(f'#10 {tag}: controls {"in header" if desktop else "in sheet"}', info['inHeader'] == desktop)
        check(f'#10 {tag}: header/sheet targets >= 44px', not small, small)
        action = '#logout' if token else '#login'
        if page.locator(action).is_visible():
            ident = info['identity']
            btn = page.locator(action).bounding_box()
            if desktop and ident and ident['w'] > 0:
                check(f'#10 {tag}: identity and account action share a row', abs((ident['y'] + ident['h'] / 2) - (btn['y'] + btn['h'] / 2)) < 12, (ident, btn))
            if desktop:
                check(f'#10 {tag}: account action reachable (inside controls box or scrollable)', btn['x'] + btn['width'] <= info['controls']['r'] + 1 or info['controlsScroll'], (btn, info['controls']))
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

(OUT / 'browser-boot.json').write_text(json.dumps({'origin': ORIGIN, 'results': results}, indent=2) + '\n')
failed = [r for r in results if not r['ok']]
print(f'{len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
