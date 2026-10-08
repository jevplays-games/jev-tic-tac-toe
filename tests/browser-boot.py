"""Initial-match recovery (#11) and header/account layout (#10) in real Chromium over normal navigation.
Start the server first on a scratch database with an empty TYPESAFE_API_KEY (see docs/TESTING.md), then:
  TEST_ORIGIN=http://127.0.0.1:18842 DATABASE_PATH=/scratch/ttt.sqlite OUT=/evidence/dir python3 tests/browser-boot.py
Failure injection uses page.route on this app's own /api paths only; no provider is involved.
The #10 matrix needs Discord to be CONFIGURED so the signed-out Sign in control exists: start the server with inert dummy
DISCORD_APPLICATION_ID (digits) and DISCORD_CLIENT_SECRET (any string). Nothing is sent to Discord: the suite blocks and
counts /api/auth requests and never clicks Sign in. The suite asserts me.discordConfigured, so a server without them fails loudly."""
import asyncio
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import uuid
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
LAYOUT_CASES = []


def check(name, ok, detail=''):
    results.append({'name': name, 'ok': bool(ok), 'detail': str(detail)})
    print(('ok   ' if ok else 'FAIL ') + name + (f'  {detail}' if detail and not ok else ''), flush=True)


def seed(name):
    out = subprocess.run(['node', str(ROOT / 'tests' / 'seed-session.js'), name], capture_output=True, text=True, env={**os.environ, 'DATABASE_PATH': DB}, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])['token']


def owner_counts(match_id):
    """Read-only scratch-DB count of active and total matches for the owner of match_id. Counts only; no identifiers."""
    if not DB:
        return None
    con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    try:
        row = con.execute('SELECT owner_session, user_id FROM matches WHERE id = ?', (match_id,)).fetchone()
        if not row:
            return None
        who = '(owner_session = ? OR (? IS NOT NULL AND user_id = ?))'
        args = (row[0], row[1], row[1])
        active = con.execute(f"SELECT COUNT(*) FROM matches WHERE status IN ('human_turn','jev_pending') AND {who}", args).fetchone()[0]
        total = con.execute(f'SELECT COUNT(*) FROM matches WHERE {who}', args).fetchone()[0]
        return {'active': active, 'total': total}
    finally:
        con.close()


def make_pending(match_id, lease_ms=None):
    """Scratch-DB fixture only: rewind a just-created match to its unopened jev_pending state (no actions, no lease), the
    state a server leaves behind when the opening was never driven. The empty model key makes the API fall back at once.
    With lease_ms, the match instead carries a LIVE lease of that length, the state while another request is driving the
    opening: the server's own driveJev then returns it pending without any provider call until the lease expires."""
    con = sqlite3.connect(DB, timeout=10)
    try:
        doc = json.loads(con.execute('SELECT doc FROM matches WHERE id = ?', (match_id,)).fetchone()[0])
        doc.update(actions=[], events=doc['events'][:1], receipts=[], status='jev_pending', revision=0, lease=({'token': 'fixture-live-lease', 'expiresAt': int(time.time() * 1000) + lease_ms} if lease_ms else None), eligible=False)
        doc.pop('outcome', None)
        con.execute("UPDATE matches SET status = 'jev_pending', revision = 0, eligible = 0, doc = ? WHERE id = ?", (json.dumps(doc), match_id))
        con.commit()
    finally:
        con.close()


def abandon_lease(match_id):
    """Scratch-DB fixture only: expire the live lease, as a driver that died would leave it. The server then recovers the
    opening itself with the perfect-play fallback and no provider call."""
    con = sqlite3.connect(DB, timeout=10)
    try:
        doc = json.loads(con.execute('SELECT doc FROM matches WHERE id = ?', (match_id,)).fetchone()[0])
        doc['lease']['expiresAt'] = int(time.time() * 1000) - 1000
        con.execute('UPDATE matches SET doc = ? WHERE id = ?', (json.dumps(doc), match_id))
        con.commit()
    finally:
        con.close()


def event_types(match_id):
    con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    try:
        doc = json.loads(con.execute('SELECT doc FROM matches WHERE id = ?', (match_id,)).fetchone()[0])
        return [e['type'] for e in doc['events']], [a.get('decision', {}).get('source') for a in doc['actions']]
    finally:
        con.close()


def match_status(match_id):
    con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    try:
        row = con.execute("SELECT status, json_extract(doc, '$.termination') FROM matches WHERE id = ?", (match_id,)).fetchone()
        return {'status': row[0], 'termination': row[1]} if row else None
    finally:
        con.close()


def rendered_board(page):
    labels = page.locator('#board button').evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")
    return ''.join('.' if l.split(', ')[1] == 'empty' else l.split(', ')[1] for l in labels)


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
    board_before_500 = rendered_board(page)
    page.route('**/api/matches/*', lambda route: route.fulfill(status=500, content_type='application/json', body='{"error":"internal"}') if route.request.method == 'GET' else route.continue_())
    page.reload()
    page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
    check(f'{label}: prior-match 500 shows retry and creates nothing', len(creates) == before)
    check(f'{label}: R6 prior-match 500 shows the visible Could-not-load error notice', page.locator('#notice').is_visible() and 'Could not' in page.locator('#notice').inner_text(), page.locator('#notice').inner_text())
    page.unroute('**/api/matches/*')
    page.locator('#boot-retry').click()
    ready(page)
    check(f'{label}: Retry after 500 restores the same match', me(page)['activeMatchId'] == first and len(creates) == before)
    check(f'{label}: R6 after the successful Retry the obsolete error banner and Retry are hidden, the same match and board stay, controls are usable and nothing was created', page.locator('#notice').is_hidden() and page.locator('#boot-actions').is_hidden() and page.locator('#new-game').is_enabled() and page.locator('#reconnect').is_visible() and me(page)['activeMatchId'] == first and rendered_board(page) == board_before_500 and board_before_500.count('.') < 9 and len(creates) == before, (page.locator('#notice').inner_text(), len(creates), before))
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


WATCH_BOOT_ERRORS = """(() => { window.__bootErrorSeen = false;
  document.addEventListener('DOMContentLoaded', () => { const el = document.getElementById('boot-actions'); if (!el) return;
    const note = () => { if (!el.hidden) window.__bootErrorSeen = true; }; note();
    new MutationObserver(note).observe(el, {attributes: true, attributeFilter: ['hidden']}); }); })();"""


def watch(page, index, log, tasks):
    """Record, per page, only safe facts about /api traffic: method, path, status, the response's error code and, for a
    match document, its id, revision, status and board. Never cookies, CSRF tokens or request headers."""
    async def record(response):
        url = response.url
        if not url.startswith(ORIGIN + '/api/'):
            return
        path = url[len(ORIGIN):]
        method = response.request.method
        entry = {'page': index, 'method': method, 'path': path, 'status': response.status}
        try:
            data = await response.json()
        except Exception:
            data = None
        if isinstance(data, dict):
            if response.status >= 400:
                entry['error'] = data.get('error')
                if isinstance(data.get('detail'), dict) and data['detail'].get('matchId'):
                    entry['detail_matchId'] = data['detail']['matchId']
            elif path == '/api/me':
                entry['activeMatchId'] = data.get('activeMatchId')
            elif 'board' in data and 'id' in data:
                entry['match'] = {'id': data['id'], 'revision': data.get('revision'), 'status': data.get('status'), 'board': ''.join(data['board'])}
        log.append(entry)
    page.on('response', lambda r: tasks.append(asyncio.ensure_future(record(r))))


async def a_rendered_board(page):
    labels = await page.locator('#board button').evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")
    return ''.join('.' if l.split(', ')[1] == 'empty' else l.split(', ')[1] for l in labels)


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
            log, tasks = [], []
            context.on('response', lambda r: outcomes.append((r.status, r.url.split('/api/')[-1])) if r.request.method == 'POST' and r.url.endswith('/api/matches') else None)
            await context.add_init_script(WATCH_BOOT_ERRORS)

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
            for index, page in enumerate(pages):
                page.on('pageerror', lambda e: errors.append(str(e)))
                watch(page, index, log, tasks)
            await asyncio.gather(*[page.goto(ORIGIN, wait_until='commit') for page in pages])
            strict = locks or warm
            first_pattern = 'Your turn' if strict else re.compile('Your turn|Could not')
            settled = await asyncio.gather(*[settle(page, first_pattern) for page in pages])
            states = [await page.locator('#game-status').inner_text() for page in pages]
            error_seen = [bool(await page.evaluate('() => window.__bootErrorSeen')) for page in pages]
            diag = {'posts': outcomes, 'states': states, 'errors': errors, 'error_ui_seen_per_page': error_seen}
            check(f'{tag}: every page settles (match or Retry) and none stays loading', all(settled), diag)
            if strict:
                # Warm/adopted: the session cookie and CSRF token are shared, so no page may ever have shown the error UI.
                check(f'{tag}: strict: no page ever showed the error state or Retry', not any(error_seen) and not any('Could not' in t for t in states), diag)
            else:
                needs_retry = [page for page, text in zip(pages, states) if 'Could not' in text]
                diag['retried'] = len(needs_retry)
                check(f'{tag}: pages that lost the race show Retry, not a local game', all([await page.locator('#boot-retry').is_visible() and 'LOCAL' not in await page.locator('#mode-badge').inner_text() for page in needs_retry]), diag)
                for page in needs_retry:
                    await page.locator('#boot-retry').click()
                recovered = await asyncio.gather(*[settle(page, 'Your turn') for page in pages])
                check(f'{tag}: Retry brings every page to the match', all(recovered), diag)
            await asyncio.gather(*tasks, return_exceptions=True)
            ids = {(await a_me(page))['activeMatchId'] for page in pages}
            final_id = next(iter(ids)) if len(ids) == 1 else None
            check(f'{tag}: all {count} pages show one match', len(ids) == 1, diag)
            created = [o for o in outcomes if 200 <= o[0] < 300]
            check(f'{tag}: the server created at most one match', len(created) <= 1, diag)
            if not locks:
                check(f'{tag}: creates really overlapped at the server', len(arrived) == count, diag)
            check(f'{tag}: no page is in an error state', all([await page.locator('#boot-actions').is_hidden() for page in pages]) and not errors, diag)

            # Per-page proof: the match each page adopted or read (id, revision, board) and what it finally rendered.
            per_page = []
            for index, page in enumerate(pages):
                events = [e for e in log if e['page'] == index]
                seen = [e['match'] for e in events if 'match' in e]
                per_page.append({'page': index, 'status_text': states[index], 'final_status_text': await page.locator('#game-status').inner_text(),
                                 'final_rendered_board': await a_rendered_board(page), 'matches_read': seen, 'last_match_read': seen[-1] if seen else None,
                                 'post_matches': [{'status': e['status'], 'error': e.get('error'), 'detail_matchId': e.get('detail_matchId')} for e in events if e['method'] == 'POST' and e['path'] == '/api/matches'],
                                 'error_codes': sorted({e['error'] for e in events if e['status'] >= 400 and e.get('error')}),
                                 'error_statuses': sorted({e['status'] for e in events if e['status'] >= 400})})
            counts = owner_counts(final_id) if final_id else None
            diag['per_page'] = per_page
            diag['owner_counts_read_only_scratch_db'] = counts
            diag['final_match_id'] = final_id
            check(f'{tag}: every page adopted/read the one final match with the same id, revision and board', all(pp['last_match_read'] and pp['last_match_read']['id'] == final_id for pp in per_page) and len({(pp['last_match_read']['revision'], pp['last_match_read']['board']) for pp in per_page if pp['last_match_read']}) == 1, diag)
            check(f'{tag}: every page finally rendered exactly that board and "Your turn"', all(pp['last_match_read'] and pp['final_rendered_board'] == pp['last_match_read']['board'] and 'Your turn' in pp['final_status_text'] for pp in per_page), diag)
            check(f'{tag}: final owner has exactly 1 active and 1 total match in the scratch DB (read-only)', counts == {'active': 1, 'total': 1}, diag)
            if strict:
                bad = [(pp['page'], pp['post_matches']) for pp in per_page if any(not (200 <= p['status'] < 300 or (p['status'] == 409 and p['error'] == 'active_match_exists' and p['detail_matchId'] == final_id)) for p in pp['post_matches'])]
                check(f'{tag}: strict: every create response was a 2xx or an adopted active_match_exists naming the final match', not bad, diag)
            else:
                errored = [pp for pp, flag in zip(per_page, error_seen) if flag]
                diag['error_pages'] = [pp['page'] for pp in errored]
                check(f'{tag}: cold: each page that showed Retry has a recorded 4xx response with an actual error code', all(pp['error_codes'] and pp['error_statuses'] for pp in errored), diag)
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
        await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
        await page.unroute('**/api/me')
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
        await page.locator('#board button[aria-label$=", X"]').first.wait_for(timeout=15000)
        await page.unroute('**/api/matches/*')
        check('retry: restores the same match with its move', (await a_me(page))['activeMatchId'] == first)
        await context.close()
        await browser.close()


async def match_doc(context, match_id):
    response = await context.request.get(f'{ORIGIN}/api/matches/{match_id}')
    data = await response.json()
    return {'status': data['status'], 'revision': data['revision'], 'board': ''.join(data['board'])}


async def recovery_suite(launch_kwargs):
    """R2 (lost committed create -> Retry -> one intentional New game) and R3 (automatic resume failure on a nonexpired
    pending match) in real Chromium. Failure injection routes only this app's /api paths; no provider is involved."""
    if not DB:
        check('recovery suite skipped: DATABASE_PATH not set', False)
        return
    async with async_playwright() as p:
        browser = await p.chromium.launch(**launch_kwargs)

        # R2: the create is committed by the server but its response is lost.
        context = await browser.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
        await context.add_init_script(WATCH_BOOT_ERRORS)
        page = await context.new_page()
        log, tasks, creates, posts, dialogs = [], [], [], [], []
        mode = {'lose': True, 'accept': True}
        watch(page, 0, log, tasks)
        page.on('request', lambda r: posts.append((r.url.split('/api/')[-1], json.loads(r.post_data)['requestId'] if r.url.endswith('/api/matches') and r.post_data else None)) if r.method == 'POST' else None)

        async def on_dialog(dialog):
            dialogs.append(dialog.message)
            await (dialog.accept() if mode['accept'] else dialog.dismiss())

        page.on('dialog', on_dialog)

        async def create_route(route):
            if route.request.method != 'POST':
                await route.continue_()
                return
            body = json.loads(route.request.post_data or '{}')
            real = await route.fetch()
            if mode['lose']:
                creates.append({'requestId': body.get('requestId'), 'server_status': real.status, 'page_saw': 500})
                await route.fulfill(status=500, content_type='application/json', body='{"error":"internal"}')
            else:
                creates.append({'requestId': body.get('requestId'), 'server_status': real.status, 'page_saw': real.status})
                await route.fulfill(response=real)

        await page.route('**/api/matches', create_route)
        await page.goto(ORIGIN)
        await page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
        check('R2: lost committed create shows error + Retry with New game disabled', 'Could not' in await page.locator('#game-status').inner_text() and await page.locator('#new-game').is_disabled())
        check('R2: the server really committed that create (2xx) while the page saw 500', len(creates) == 1 and 200 <= creates[0]['server_status'] < 300, creates)
        first = (await a_me(page))['activeMatchId']
        before = await match_doc(context, first)
        check('R2: authoritative me shows the committed match as active; scratch DB has 1 active, 1 total', bool(first) and owner_counts(first) == {'active': 1, 'total': 1}, owner_counts(first) if first else None)
        mode['lose'] = False
        await page.locator('#boot-retry').click()
        await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
        check('R2: Retry restores the same match and the same board/revision, with no duplicate create', (await a_me(page))['activeMatchId'] == first and await a_rendered_board(page) == before['board'] and (await match_doc(context, first)) == before and len(creates) == 1 and owner_counts(first) == {'active': 1, 'total': 1}, (creates, owner_counts(first)))
        # Cancelling the confirm makes no request at all.
        mode['accept'] = False
        n = len(posts)
        await page.locator('#new-game').click()
        await page.wait_for_timeout(500)
        check('R2: cancelling New game sends nothing and leaves the match and board unchanged', len(posts) == n and len(dialogs) == 1 and (await a_me(page))['activeMatchId'] == first and await a_rendered_board(page) == before['board'], (posts[n:], dialogs))
        # ONE intentional New game: resign the old match, create one fresh playable match with a NEW key.
        mode['accept'] = True
        n = len(posts)
        await page.locator('#new-game').click()
        for _ in range(150):
            if (await a_me(page))['activeMatchId'] not in (first, None):
                break
            await page.wait_for_timeout(100)
        await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
        second = (await a_me(page))['activeMatchId']
        sent = posts[n:]
        resign_posts = [x for x in sent if x[0].endswith('/actions')]
        create_posts = [x for x in sent if x[0] == 'matches']
        check('R2: one New game sends exactly one resign and one create, with a different requestId from the lost one', len(resign_posts) == 1 and len(create_posts) == 1 and create_posts[0][1] != creates[0]['requestId'], sent)
        check('R2: the result is a different, playable match and the old one is resigned (not replayed)', bool(second) and second != first and match_status(first) == {'status': 'complete', 'termination': 'resign'} and match_status(second)['status'] == 'human_turn' and await a_rendered_board(page) == '.........', (first, second, match_status(first), match_status(second)))
        check('R2: scratch DB now has exactly 1 active and 2 total matches for the owner', owner_counts(second) == {'active': 1, 'total': 2}, owner_counts(second))
        check('R2: the page never showed a second error state after Retry and made no extra create', len(creates) == 2 and not await page.locator('#boot-actions').is_visible())
        await asyncio.gather(*tasks, return_exceptions=True)
        (OUT / 'recovery-lost-create.json').write_text(json.dumps({'creates': creates, 'posts_after_boot': [list(x) for x in posts], 'dialogs': dialogs, 'first': first, 'second': second, 'first_final': match_status(first), 'second_final': match_status(second), 'owner_counts': owner_counts(second), 'responses': log}, indent=2) + '\n')
        await context.close()

        # R3: a nonexpired pending match (human plays O so the opponent moves first) whose automatic resume fails.
        context = await browser.new_context(viewport={'width': 390, 'height': 844}, reduced_motion='reduce')
        await context.add_init_script(WATCH_BOOT_ERRORS)
        session = await (await context.request.get(ORIGIN + '/api/me')).json()
        seeded = await context.request.post(ORIGIN + '/api/matches', headers={'x-csrf-token': session['csrf'], 'origin': ORIGIN}, data={'requestId': str(uuid.uuid4()), 'humanMark': 'O', 'difficulty': 'normal', 'ranked': False})
        pending = await seeded.json()
        make_pending(pending['id'])
        fixture = await match_doc(context, pending['id'])
        expires = sqlite3.connect(f'file:{DB}?mode=ro', uri=True).execute('SELECT expires_at FROM matches WHERE id = ?', (pending['id'],)).fetchone()[0]
        check('R3: fixture is a nonexpired unopened pending (jev_pending) match, rewound in the scratch DB only', seeded.status in (201, 202) and fixture['status'] == 'jev_pending' and fixture['revision'] == 0 and fixture['board'] == '.........' and expires > time.time() * 1000, (seeded.status, fixture, expires))
        page = await context.new_page()
        resumes, creates3, gate_get = [], [], asyncio.Event()
        gate_get.set()
        failing = {'resume': True}
        page.on('request', lambda r: creates3.append(r.url) if r.method == 'POST' and r.url.endswith('/api/matches') else None)

        async def resume_route(route):
            resumes.append(1)
            if failing['resume']:
                await route.fulfill(status=503, content_type='application/json', body='{"error":"unavailable"}')
            else:
                await route.continue_()

        async def get_route(route):
            if route.request.method == 'GET':
                await gate_get.wait()
            await route.continue_()

        await page.route('**/api/matches/*/resume', resume_route)
        await page.route('**/api/matches/*', get_route)
        base = await match_doc(context, pending['id'])
        await page.goto(ORIGIN)
        await page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
        text = await page.locator('#game-status').inner_text()
        check('R3: failed automatic resume shows visible error text and a usable Retry, no replacement offered', 'Could not' in text and await page.locator('#boot-retry').is_enabled() and await page.locator('#new-game').is_disabled() and await page.locator('#boot-local').is_hidden(), text)
        check('R3: the same match, board and revision stay on screen; not local; no create', (await a_me(page))['activeMatchId'] == pending['id'] and await a_rendered_board(page) == base['board'] and await match_doc(context, pending['id']) == base and 'LOCAL' not in await page.locator('#mode-badge').inner_text() and not creates3, (text, creates3))
        await page.wait_for_timeout(3500)
        check('R3: exactly one automatic resume attempt, none repeated on its own', len(resumes) == 1, len(resumes))
        gate_get.clear()
        await page.locator('#boot-retry').click()
        await page.locator('#game-status', has_text='Loading your game').wait_for(timeout=10000)
        check('R3: Retry on the displayed match shows loading while the board stays', await page.locator('#boot-actions').is_hidden() and await a_rendered_board(page) == base['board'] and await page.locator('#new-game').is_disabled())
        gate_get.set()
        await page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
        check('R3: that Retry reloads the same match and makes one more resume attempt, which fails visibly again', len(resumes) == 2 and 'Could not' in await page.locator('#game-status').inner_text() and await match_doc(context, pending['id']) == base and not creates3, (len(resumes), creates3))
        await page.wait_for_timeout(3500)
        check('R3: still no repeated provider opening and still no replacement or local fallback', len(resumes) == 2 and not creates3 and 'LOCAL' not in await page.locator('#mode-badge').inner_text())
        notice_text = await page.locator('#notice').inner_text()
        check('R6 R3: the failed second recovery keeps exactly one visible Could-not-refresh notice (not stacked, not hidden)', await page.locator('#notice').is_visible() and notice_text.count('Could not refresh your saved game') == 1, notice_text)
        failing['resume'] = False
        await page.locator('#boot-retry').click()
        await page.locator('#game-status', has_text='Your turn').wait_for(timeout=20000)
        after = await match_doc(context, pending['id'])
        check('R6 R3: after the successful third Retry and the automatic pending completion the older error banner and Retry are hidden, New game and Reconnect are usable, same match id, no create',
              await page.locator('#notice').is_hidden() and await page.locator('#boot-actions').is_hidden() and await page.locator('#new-game').is_enabled() and await page.locator('#reconnect').is_visible() and (await a_me(page))['activeMatchId'] == pending['id'] and not creates3, (await page.locator('#notice').inner_text(), creates3))
        check('R3: a later Retry resumes the very same match (opponent has moved) with no create and a 1/1 scratch DB', len(resumes) == 3 and (await a_me(page))['activeMatchId'] == pending['id'] and after['revision'] > base['revision'] and after['board'].count('.') == 8 and await a_rendered_board(page) == after['board'] and not creates3 and owner_counts(pending['id']) == {'active': 1, 'total': 1}, (len(resumes), base, after, owner_counts(pending['id'])))
        await context.close()

        # R5: a SUCCESSFUL manual Reconnect must clear the boot error raised by the automatic resume (503), with the
        # same match, board and revision progression, no replacement create and a bounded, lease-aware poll.
        async def reconnect_case(tag, lease_ms):
            context = await browser.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
            await context.add_init_script(WATCH_BOOT_ERRORS)
            session = await (await context.request.get(ORIGIN + '/api/me')).json()
            seeded = await context.request.post(ORIGIN + '/api/matches', headers={'x-csrf-token': session['csrf'], 'origin': ORIGIN}, data={'requestId': str(uuid.uuid4()), 'humanMark': 'O', 'difficulty': 'normal', 'ranked': False})
            mid = (await seeded.json())['id']
            make_pending(mid, lease_ms)
            base = await match_doc(context, mid)
            check(f'R5 {tag}: fixture is an unopened nonexpired jev_pending match' + (' with a live lease' if lease_ms else ' without a lease') + ' in the scratch DB only', base['status'] == 'jev_pending' and base['revision'] == 0 and base['board'] == '.........', base)
            page = await context.new_page()
            seen, creates5, mode5 = [], [], {'fail': True}
            page.on('request', lambda r: creates5.append(r.url) if r.method == 'POST' and r.url.endswith('/api/matches') else None)

            async def route5(route):
                if mode5['fail']:
                    seen.append({'fail': True})
                    await route.fulfill(status=503, content_type='application/json', body='{"error":"unavailable"}')
                    return
                real = await route.fetch()
                data = await real.json()
                seen.append({'fail': False, 'http': real.status, 'status': data.get('status'), 'revision': data.get('revision'), 'id': data.get('id')})
                await route.fulfill(response=real)

            async def wait_seen(n, timeout=30):
                for _ in range(timeout * 10):
                    if len(seen) >= n:
                        return True
                    await page.wait_for_timeout(100)
                return False

            await page.route('**/api/matches/*/resume', route5)
            await page.goto(ORIGIN + '/#reconnect')
            await page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
            check(f'R5 {tag}: the automatic resume failed with a 503 and left a visible error, Retry and a disabled New game', len(seen) == 1 and 'Could not' in await page.locator('#game-status').inner_text() and await page.locator('#new-game').is_disabled() and await page.locator('#reconnect').is_visible(), len(seen))
            await page.locator('#reconnect').click()
            await wait_seen(2)
            await page.wait_for_timeout(500)
            failed_text = await page.locator('#game-status').inner_text()
            check(f'R5 {tag}: a FAILED manual Reconnect keeps the visible error, the same board, a disabled New game and no false ready', len(seen) == 2 and await page.locator('#notice').is_visible() and bool((await page.locator('#notice').inner_text()).strip()) and await page.locator('#boot-actions').is_visible() and 'Could not' in failed_text and await a_rendered_board(page) == base['board'] and await page.locator('#new-game').is_disabled() and 'LOCAL' not in await page.locator('#mode-badge').inner_text() and await match_doc(context, mid) == base and not creates5, (len(seen), failed_text, creates5))
            mode5['fail'] = False
            await page.locator('#reconnect').click()
            await wait_seen(3)
            ok_resp = seen[2]
            if lease_ms:
                await page.locator('#game-status', has_text='evaluating').wait_for(timeout=10000)
                check(f'R5 {tag}: the successful manual response is still jev_pending (202) and it already cleared the stale error and Retry', ok_resp['http'] == 202 and ok_resp['status'] == 'jev_pending' and ok_resp['id'] == mid and await page.locator('#boot-actions').is_hidden() and 'Could not' not in await page.locator('#game-status').inner_text() and not (await page.locator('#notice').is_visible() and 'unavailable' in await page.locator('#notice').inner_text()) and await a_rendered_board(page) == base['board'] and await page.locator('#new-game').is_disabled(), (ok_resp, await page.locator('#game-status').inner_text()))
                await wait_seen(5)
                check(f'R5 {tag}: the page keeps polling the live lease on its own (lease-aware: the server answers pending, no new decision)', all(x.get('status') == 'jev_pending' and x['revision'] == 0 for x in seen[2:5]) and await page.locator('#boot-actions').is_hidden() and not creates5, seen[2:5])
                abandon_lease(mid)
                await page.locator('#game-status', has_text='Your turn').wait_for(timeout=30000)
            else:
                await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
            after = await match_doc(context, mid)
            check(f'R5 {tag}: after the successful Reconnect the stale error and Retry are gone and the same match shows the opponent\'s move at a later revision', await page.locator('#boot-actions').is_hidden() and await page.locator('#boot-retry').is_hidden() and not await page.locator('#notice').is_visible() and 'Could not' not in await page.locator('#game-status').inner_text() and (await a_me(page))['activeMatchId'] == mid and after['revision'] > base['revision'] and after['board'].count('.') == 8 and await a_rendered_board(page) == after['board'], (base, after))
            check(f'R5 {tag}: New game is enabled on human_turn, there was zero replacement create, and the scratch DB has 1 active / 1 total', await page.locator('#new-game').is_enabled() and not creates5 and owner_counts(mid) == {'active': 1, 'total': 1} and 'LOCAL' not in await page.locator('#mode-badge').inner_text(), (creates5, owner_counts(mid)))
            n = len(seen)
            await page.wait_for_timeout(4000)
            check(f'R5 {tag}: polling stops once the match is no longer pending', len(seen) == n, (n, len(seen)))
            if lease_ms:
                types, sources = event_types(mid)
                check(f'R5 {tag}: the abandoned lease was recovered by the server with its perfect-play fallback (no blind provider request was prepared)', 'decision_recovery' in types and 'jev_request_prepared' not in types and 'fallback-minimax' in sources, (types, sources))
            (OUT / f'recovery-reconnect-{tag}.json').write_text(json.dumps({'base': base, 'after': after, 'resume_attempts': seen, 'creates': len(creates5), 'owner_counts': owner_counts(mid)}, indent=2) + '\n')
            await context.close()

        await reconnect_case('503-then-ok', None)
        await reconnect_case('503-then-pending-then-ok', 120000)

        # R6: a session notice from the current load must survive a boot error and a successful Retry, while the boot error
        # notice itself is retired. The session notice is produced by the app's own loadSession path; only the /api/me
        # response body is rewritten in the route (discordConfigured=false, Set-Cookie preserved), so this is interception.
        async def notice_case():
            context = await browser.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
            page = await context.new_page()
            creates6, gets = [], []
            mode6 = {'fail': False}
            page.on('request', lambda r: creates6.append(r.url) if r.method == 'POST' and r.url.endswith('/api/matches') else None)

            async def me_route(route):
                real = await route.fetch()
                data = await real.json()
                data['discordConfigured'] = False
                headers = {k: v for k, v in real.headers.items() if k.lower() != 'content-length'}
                await route.fulfill(status=real.status, headers=headers, body=json.dumps(data))

            async def get_route(route):
                if mode6['fail'] and route.request.method == 'GET':
                    gets.append(1)
                    await route.fulfill(status=500, content_type='application/json', body='{"error":"internal"}')
                else:
                    await route.continue_()

            await page.route('**/api/me', me_route)
            await page.route('**/api/matches/*', get_route)
            await page.goto(ORIGIN)
            await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
            await page.locator('#board button').nth(4).click()
            await page.locator('#board button[aria-label$=", O"]').first.wait_for(timeout=15000)
            await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
            # place() clears the notice, so a fresh real load on the existing board is what shows the session notice.
            await page.reload()
            await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
            first = (await a_me(page))['activeMatchId']
            board6 = await a_rendered_board(page)
            doc6 = await match_doc(context, first)
            session_text = await page.locator('#notice').inner_text()
            check('R6 notice: after a move and a reload on the same board, the app\'s own session notice (Local-ready build) is shown by the fresh load, one create so far', await page.locator('#notice').is_visible() and 'Local-ready build' in session_text and len(creates6) == 1 and board6.count('.') == 7, (session_text, len(creates6), board6))
            mode6['fail'] = True
            await page.reload()
            await page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
            text1 = await page.locator('#notice').inner_text()
            # A fresh page has no match loaded when the GET fails, so the board shown here is the failure board, not board6.
            shown_board = await a_rendered_board(page)
            check('R6 notice: a prior-match 500 keeps the session notice AND adds the Could-not-load error notice', 'Local-ready build' in text1 and text1.count('Could not load your saved game') == 1 and len(creates6) == 1, text1)
            await page.locator('#boot-retry').click()
            for _ in range(100):
                if len(gets) >= 2:
                    break
                await page.wait_for_timeout(100)
            await page.locator('#boot-actions').wait_for(state='visible', timeout=15000)
            await page.wait_for_timeout(300)
            text2 = await page.locator('#notice').inner_text()
            check('R6 notice: a failed Retry keeps the failure visible with exactly one error notice, the session notice intact, the same displayed failure board, no local fallback, no create', len(gets) >= 2 and 'Local-ready build' in text2 and text2.count('Could not load your saved game') == 1 and text2.count('Local-ready build') == 1 and await a_rendered_board(page) == shown_board and 'LOCAL' not in await page.locator('#mode-badge').inner_text() and len(creates6) == 1, (len(gets), text2))
            mode6['fail'] = False
            await page.locator('#boot-retry').click()
            await page.locator('#game-status', has_text='Your turn').wait_for(timeout=15000)
            text3 = await page.locator('#notice').inner_text()
            check('R6 notice: after the successful Retry the error notice is gone, the current load\'s session notice remains, Retry is hidden, controls usable, same match, the ORIGINAL saved board and revision restored, no create, scratch DB 1/1',
                  'Could not' not in text3 and 'Local-ready build' in text3 and text3.count('Local-ready build') == 1 and await page.locator('#boot-actions').is_hidden() and await page.locator('#new-game').is_enabled() and await page.locator('#reconnect').is_visible() and (await a_me(page))['activeMatchId'] == first and await a_rendered_board(page) == board6 and await match_doc(context, first) == doc6 and len(creates6) == 1 and owner_counts(first) == {'active': 1, 'total': 1}, (text3, len(creates6), owner_counts(first)))
            await context.close()

        await notice_case()

        await browser.close()


WIDTHS = [(320, 568), (390, 844), (768, 1024), (899, 800), (900, 800), (1000, 800), (1099, 800), (1100, 800), (1280, 720), (1920, 1080)]


def layout(browser, label, token, name):
    for width, height in WIDTHS:
        context = new_context(browser, token, {'width': width, 'height': height})
        page = context.new_page()
        auth_requests = []
        context.route('**/api/auth/**', lambda route: (auth_requests.append(route.request.url), route.abort()))
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
            .map(e => ({id: e.id || e.textContent.trim(), ...box(e), clipped: e.scrollWidth > e.clientWidth + 1 && !(e.id === 'identity-name' && getComputedStyle(e).textOverflow === 'ellipsis' && getComputedStyle(e).overflow === 'hidden' && ['block', 'inline-block'].includes(getComputedStyle(e).display))}));
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
        action, other = ('#logout', '#login') if token else ('#login', '#logout')
        want_text = 'Sign out' if token else 'Sign in'
        configured = me(page)['discordConfigured']
        check(f'#10 {tag}: Discord is configured in this env (inert dummy credentials), so Sign in can exist', configured is True, configured)
        shown = page.locator(action).is_visible()
        label_text = page.locator(action).inner_text().strip() if shown else ''
        check(f'#10 {tag}: the expected {want_text} control is visible with its label (a hidden control is a failure)', shown and label_text.startswith(want_text), repr(label_text))
        check(f'#10 {tag}: the opposite account control is hidden', page.locator(other).is_hidden())
        want_name = name if token else 'Guest'
        check(f'#10 {tag}: identity text is {want_name!r}', page.locator('#identity-name').inner_text().strip() == want_name, page.locator('#identity-name').inner_text())
        LAYOUT_CASES.append({'tag': tag, 'configured': configured is True, 'action': action, 'visible': shown})
        if shown:
            ident = info['identity']
            btn = page.locator(action).bounding_box()
            boxes = page.evaluate("""() => { const b = e => { const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, r: r.right, b: r.bottom}; };
              return {row: b(document.querySelector('.account-row')), sheet: b(document.getElementById('jv-sheet')), header: b(document.querySelector('.jv-header'))}; }""")
            check(f'#10 {tag}: account action target is >= 44x44', btn['width'] >= 43.5 and btn['height'] >= 43.5, btn)
            inside_row = btn['x'] >= boxes['row']['x'] - 1 and btn['x'] + btn['width'] <= boxes['row']['r'] + 1 and btn['y'] >= boxes['row']['y'] - 1 and btn['y'] + btn['height'] <= boxes['row']['b'] + 1
            check(f'#10 {tag}: identity and account action are one group (the action sits inside the account row)', inside_row, (btn, boxes['row']))
            check(f'#10 {tag}: no /api/auth request was made (nothing reaches Discord)', not auth_requests, auth_requests)
            if desktop:
                check(f'#10 {tag}: account action sits inside the header', btn['y'] >= boxes['header']['y'] - 1 and btn['y'] + btn['height'] <= boxes['header']['b'] + 1, (btn, boxes['header']))
                check(f'#10 {tag}: identity and account action share a row', bool(ident and ident['w'] > 0) and abs((ident['y'] + ident['h'] / 2) - (btn['y'] + btn['height'] / 2)) < 12, (ident, btn))
                check(f'#10 {tag}: account action fully inside the controls box without scrolling', btn['x'] >= info['controls']['x'] - 1 and btn['x'] + btn['width'] <= info['controls']['r'] + 1 and not info['controlsScroll'], (btn, info['controls'], info['controlsScroll']))
            else:
                check(f'#10 {tag}: account action is fully inside the sheet and the viewport', btn['x'] >= boxes['sheet']['x'] - 1 and btn['x'] + btn['width'] <= min(boxes['sheet']['r'], width) + 1 and btn['y'] >= 0 and btn['y'] + btn['height'] <= min(boxes['sheet']['b'], height) + 1, (btn, boxes['sheet'], width, height))
            page.locator(action).focus()
            page.keyboard.press('Shift+Tab')
            page.keyboard.press('Tab')
            ring = page.evaluate("""() => {
              const el = document.activeElement, s = getComputedStyle(el), r = el.getBoundingClientRect();
              const grow = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset || 0), clippedBy = [];
              for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
                const cs = getComputedStyle(a);
                if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
                const b = a.getBoundingClientRect();
                if (r.left - grow < b.left - 0.5 || r.right + grow > b.right + 0.5 || r.top - grow < b.top - 0.5 || r.bottom + grow > b.bottom + 0.5) clippedBy.push(a.id || a.className);
              }
              return {outline: s.outlineStyle, w: parseFloat(s.outlineWidth), shadow: s.boxShadow, clippedBy};
            }""")
            check(f'#10 {tag}: keyboard focus ring visible on account action', (ring['outline'] != 'none' and ring['w'] > 0) or ring['shadow'] != 'none', ring)
            check(f'#10 {tag}: focus ring is not clipped by a scrolling or clipping ancestor', not ring['clippedBy'], ring)
        page.screenshot(path=str(OUT / f'layout-{label.replace(" ", "-")}-{width}x{height}.png'))
        context.close()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None, headless=True, args=['--no-sandbox', '--renderer-process-limit=2'])
    boot_flows(browser, 'guest', None)
    tabs(browser)
    if DB:
        boot_flows(browser, 'signed-in', seed('Fixture Player'))
        layout(browser, 'signed-in', seed('Fixture Player Layout'), 'Fixture Player Layout')
        layout(browser, 'signed-in long name', seed('Alexandria Konstantinopolous-Featherstonehaugh'), 'Alexandria Konstantinopolous-Featherstonehaugh')
    else:
        check('signed-in checks skipped: DATABASE_PATH not set', False)
    layout(browser, 'signed-out', None, None)
    browser.close()
check('#10 layout matrix: all 30 cases (3 labels x 10 widths) ran with Discord configured and the expected account action visible',
      len(LAYOUT_CASES) == 30 and all(c['configured'] and c['visible'] for c in LAYOUT_CASES), [c for c in LAYOUT_CASES if not (c['configured'] and c['visible'])] or len(LAYOUT_CASES))

LAUNCH = {'executable_path': os.environ.get('CHROMIUM_PATH') or None, 'headless': True, 'args': ['--no-sandbox', '--renderer-process-limit=2']}
asyncio.run(overlap_suite(LAUNCH))
asyncio.run(recovery_suite(LAUNCH))

(OUT / 'browser-boot.json').write_text(json.dumps({'origin': ORIGIN, 'results': results}, indent=2) + '\n')
failed = [r for r in results if not r['ok']]
print(f'{len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
