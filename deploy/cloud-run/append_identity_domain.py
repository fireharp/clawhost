import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


def main() -> int:
    web_url = os.environ.get('WEB_URL', '')
    project = os.environ.get('GCP_PROJECT', '')
    if not web_url or not project:
        return 0
    host = urllib.parse.urlparse(web_url).hostname
    if not host:
        return 0
    token = subprocess.check_output(
        ['gcloud', 'auth', 'print-access-token'],
        text=True
    ).strip()
    get_req = urllib.request.Request(
        f'https://identitytoolkit.googleapis.com/admin/v2/projects/{project}/config',
        headers={'Authorization': f'Bearer {token}'},
        method='GET'
    )
    try:
        with urllib.request.urlopen(get_req) as r:
            cfg = json.load(r)
    except urllib.error.HTTPError as e:
        sys.stderr.write(
            f'identity toolkit GET skipped ({e.code}): enable Firebase Auth / Identity Platform\n'
        )
        return 0
    except OSError as e:
        sys.stderr.write(f'identity toolkit GET failed: {e}\n')
        return 0
    domains = list(cfg.get('authorizedDomains') or [])
    if host in domains:
        return 0
    domains.append(host)
    body = json.dumps({'authorizedDomains': domains}).encode()
    patch_req = urllib.request.Request(
        f'https://identitytoolkit.googleapis.com/admin/v2/projects/{project}/config?updateMask=authorizedDomains',
        data=body,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        },
        method='PATCH'
    )
    try:
        urllib.request.urlopen(patch_req)
    except urllib.error.HTTPError as e:
        sys.stderr.write(f'identity toolkit PATCH failed ({e.code}): {e.read()!r}\n')
        return 0
    except OSError as e:
        sys.stderr.write(f'identity toolkit PATCH failed: {e}\n')
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
