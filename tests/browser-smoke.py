"""Real Chromium UI smoke tests. Start `npm start` first. Optional dev dependency: playwright."""
import json
import os
import re
import base64
import urllib.request
import urllib.error
import http.cookiejar
from functools import lru_cache
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get('TEST_ORIGIN', 'http://localhost:8787')
REPORT = ROOT / 'reports'
REPORT.mkdir(exist_ok=True)
checks = []
EMBEDDED = os.environ.get('EMBEDDED_BROWSER') == '1'
@lru_cache(maxsize=None)
def embedded_module(path):
    path = Path(path).resolve()
    text = path.read_text()
    def replace(match):
        target = (path.parent / match.group(2)).resolve()
        return match.group(1) + embedded_module(str(target)) + match.group(3)
    text = re.sub(r'''(from\s+['"])(\.[^'"]+)(['"])''', replace, text)
    return 'data:text/javascript;base64,' + base64.b64encode(text.encode()).decode()


with sync_playwright() as p:
    executable = os.environ.get('CHROMIUM_PATH')
    browser = p.chromium.launch(**({'executable_path': executable} if executable else {}), headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1150}, reduced_motion='reduce', accept_downloads=True)
    page = context.new_page()
    page.set_default_timeout(5000)
    errors = []
    page.on('pageerror', lambda error: (errors.append(str(error)), print('BROWSER ERROR:',str(error),flush=True)))
    if EMBEDDED:
        # Rendering-only fallback for containers that prohibit all browser URL navigation.
        # Network policy stays intact. Known app assets are supplied in memory, and
        # API calls use an explicit test bridge to the already-running loopback server.
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        def request_bridge(path, options):
            headers = dict(options.get('headers', {}))
            headers['Origin'] = URL
            body = options.get('body')
            request = urllib.request.Request(URL + path, data=body.encode() if body else None, headers=headers, method=options.get('method', 'GET'))
            try:
                response = opener.open(request, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            return {'body': response.read().decode(), 'status': response.status, 'headers': dict(response.headers)}
        page.expose_function('__localRequest', request_bridge)
        page.evaluate('''() => { window.fetch = async (path, options = {}) => {
            const r = await window.__localRequest(String(path), options);
            return new Response(r.body, {status:r.status, headers:r.headers});
        }; }''')
        html = (ROOT / 'public/index.html').read_text()
        html = re.sub(r'<script.*?</script>', '', html, flags=re.S)
        html = html.replace('<link rel="stylesheet" href="/game.css">', '<style>' + (ROOT / 'public/game.css').read_text() + '</style>')
        page.set_content(html)
        page.evaluate('(uri) => import(uri)', embedded_module(str(ROOT / 'public/app.js')))
    else:
        page.goto(URL, wait_until='networkidle')
    page.wait_for_function("document.querySelector('#service-status').textContent !== 'Connecting to game service'")
    assert page.locator('#board button').count() == 9
    if not EMBEDDED:
        assert any(c['httpOnly'] for c in context.cookies())
        assert not page.evaluate("document.cookie.includes('jev_dev_session')")
        checks.append('HttpOnly session is hidden from browser JavaScript')
    checks.append('Nine accessible board controls')
    page.screenshot(path=str(REPORT/'ui-desktop.png'), full_page=True)
    page.locator('#show-rules').click()
    assert page.locator('#rules-dialog').evaluate('(e) => e.open')
    page.locator('#rules-dialog [data-close-dialog]').click()
    checks.append('In-page rules dialog opens and closes')
    page.locator('#new-game').click()
    page.wait_for_function("document.querySelector('#game-status').textContent.includes('Your turn')")
    page.locator('#board button').nth(0).focus()
    page.keyboard.press('ArrowRight')
    assert page.evaluate("document.activeElement.dataset.cell") == '1'
    checks.append('Arrow-key navigation preserves accessible board focus')
    for _ in range(9):
        if page.locator('#postgame').is_visible():
            break
        page.wait_for_function("document.querySelector('#postgame').hidden === false || (!document.body.classList.contains('busy') && document.querySelectorAll('#board button[aria-disabled=false]').length > 0)")
        if page.locator('#postgame').is_visible():
            break
        page.locator('#board button[aria-disabled=false]').first.click()
        page.wait_for_function("!document.body.classList.contains('busy')")
    assert page.locator('#postgame').is_visible()
    assert page.locator('#move-table tr').count() >= 5
    assert page.locator('#opponent-name').inner_text() == 'Local oracle'
    assert 'not selected by JEV' in page.locator('#evidence-note').inner_text()
    checks.append('Complete game against visibly labeled local fallback with move analytics')
    page.locator('#replay-step').fill('0')
    assert 'Replay' in page.locator('#game-status').inner_text()
    assert all('empty' in s for s in page.locator('#board button').evaluate_all('(els) => els.map(e => e.getAttribute("aria-label"))'))
    page.locator('#return-live').click()
    checks.append('Replay reconstructs initial and final positions')
    with page.expect_download() as info:
        page.locator('#download-match').click()
    download = info.value
    path = REPORT/'browser-match-export.json'
    download.save_as(str(path))
    exported = json.loads(path.read_text())
    assert exported['audit']['ok'] is True
    assert len(exported['events']) > 0
    checks.append('Full request/response/event JSON export downloads')
    page.locator('[data-view=analytics]').click()
    page.wait_for_function("document.querySelectorAll('#metric-grid .metric').length === 6")
    assert page.locator('#source-table').inner_text().find('Fallback') >= 0
    assert page.locator('#heatmap .heat-cell').count() == 9
    assert '5,478' in page.locator('#audit-reference').inner_text()
    page.screenshot(path=str(REPORT/'ui-analytics.png'), full_page=True)
    checks.append('Analytics panels, source separation, placement map and reference audit render')
    with page.expect_download() as info:
        page.locator('#export-all').click()
    all_path = REPORT/'browser-all-export.json'
    info.value.save_as(str(all_path))
    assert len(json.loads(all_path.read_text())['matches']) >= 1
    checks.append('Paginated all-match export downloads')
    page.locator('[data-view=records]').click()
    page.wait_for_function("document.querySelectorAll('#history-table tr').length > 0")
    checks.append('Private match history displays completed records')
    page.locator('[data-view=play]').click()
    page.locator('#analysis-toggle').uncheck()
    assert not page.locator('#evidence-panel').is_visible()
    page.locator('#analysis-toggle').check()
    checks.append('Decision-evidence visibility control works')
    page.set_viewport_size({'width':375,'height':900})
    page.evaluate('window.scrollTo(0,0)')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(REPORT/'ui-mobile.png'), full_page=True)
    checks.append('375-pixel mobile layout has no document-level horizontal overflow')
    assert not errors, errors
    checks.append('No uncaught browser JavaScript exceptions')
    browser.close()
result = {'browser': 'Chromium', 'basis': 'In-memory assets + actual local SQLite HTTP API via test bridge; navigation/cookie isolation not covered' if EMBEDDED else 'Actual local server + SQLite + no-key fallback, NOT live JEV or Discord', 'passed': len(checks), 'checks': checks, 'pageErrors': errors}
(REPORT/'browser-test-results.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result, indent=2))
