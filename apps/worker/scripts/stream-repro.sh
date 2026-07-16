#!/bin/zsh
# Repro harness for the studio chat stream stall.
# Creates project+chat, starts a turn, polls /streams/:id at 400ms like the
# client, and logs timing per poll: wall clock, append bytes, nextOffset,
# status, server lastEventAt gap.
set -e
BASE=http://localhost:8787
HDR=(-H "X-Studio-Hub-Id: 1" -H "X-Studio-User-Id: 1" -H "Content-Type: application/json")

PROJECT=$(curl -s "${HDR[@]}" -X POST $BASE/projects -d '{"name":"stall-repro"}')
PID=$(echo "$PROJECT" | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")
CID=$(echo "$PROJECT" | python3 -c "import sys,json; print(json.load(sys.stdin)['defaultChatId'])")
echo "project=$PID chat=$CID"

NONCE=$(date +%s)
START=$(curl -s "${HDR[@]}" -X POST $BASE/chat -d "{\"projectId\":\"$PID\",\"chatId\":\"$CID\",\"userMessage\":\"Build a card that shows a list of 5 open support tickets with priority tags, a summary stat row (open, urgent, avg age), and an alert when any ticket is urgent. Use sample data. (session $NONCE)\"}")
echo "start: $START"
SID=$(echo "$START" | python3 -c "import sys,json; print(json.load(sys.stdin)['streamId'])")

python3 - "$BASE" "$SID" <<'EOF'
import json, sys, time, urllib.request

base, sid = sys.argv[1], sys.argv[2]
offset = 0
cursor = 0
t0 = time.time()
last_advance = t0
polls = 0
while True:
    polls += 1
    t_req = time.time()
    url = f"{base}/streams/{sid}?since={offset}&patchesSince={cursor}"
    req = urllib.request.Request(url, headers={"X-Studio-Hub-Id": "1", "X-Studio-User-Id": "1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except Exception as e:
        print(f"{time.time()-t0:7.2f}s poll#{polls} FETCH-ERROR {e}")
        time.sleep(0.4)
        continue
    dt = time.time() - t_req
    append = data.get("append") or ""
    nxt = data.get("nextOffset", offset)
    status = data.get("status")
    lea = data.get("lastEventAt")
    now_srv = data.get("serverNow")
    gap = (now_srv - lea) / 1000 if (lea and now_srv) else None
    patches = data.get("patches") or {}
    plog = patches.get("log") or []
    if patches.get("nextCursor") is not None:
        cursor = patches["nextCursor"]
    marker = ""
    if append:
        since_adv = time.time() - last_advance
        if since_adv > 3:
            marker = f"  <-- RESUMED after {since_adv:.1f}s silence"
        last_advance = time.time()
    stalled_for = time.time() - last_advance
    for p in plog:
        ats = (p.get("at", 0) / 1000)
        ops0 = (p.get("ops") or [{}])[0]
        print(f"    PATCH seq={p.get('seq')} at=+{ats - t0:6.1f}s op={ops0.get('op')} path={ops0.get('path')}")
    if append or plog or status != "streaming" or stalled_for > 2:
        print(f"{time.time()-t0:7.2f}s poll#{polls:<4} rtt={dt*1000:4.0f}ms status={status:<9} +{len(append):<5}b off={nxt:<6} patches=+{len(plog):<3} srvgap={gap if gap is None else round(gap,1)}s silent={stalled_for:4.1f}s phase={data.get('phase','')!r}{marker}")
    offset = nxt
    if status in ("done", "error"):
        print("FINAL:", json.dumps({k: data.get(k) for k in ("status", "error", "usage")}, default=str))
        print(f"total content bytes: {offset}, wall: {time.time()-t0:.1f}s, polls: {polls}")
        break
    time.sleep(0.4)
EOF
