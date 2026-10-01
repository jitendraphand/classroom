# School app → Classroom integration

For the developers of the school's own app (the app students already use).
Students no longer type a class code: the school app sends them to the
classroom with a short-lived **signed join link**. The classroom trusts the
student's identity, grade and division from that link, finds the class that is
on for that grade-division right now and puts the student in its waiting room.

```
Student taps "Join class"
  → school app asks ITS OWN BACKEND for a join link
  → backend signs a JWT (private key never leaves the backend)
  → app opens  https://CLASSROOM_HOST/join?t=<JWT>  in Custom Tabs / SFSafariViewController
  → classroom verifies, signs the student in, routes to the live class / countdown / "no class now"
```

## 1. Keys (pick one)

**Preferred: Ed25519 (EdDSA) or RSA (RS256) key pair.** The school backend keeps
the private key; the classroom only gets the public key.

```bash
# Ed25519 (recommended)
openssl genpkey -algorithm ed25519 -out school-app-private.pem
openssl pkey -in school-app-private.pem -pubout -out school-app-public.pem
# or RSA
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out school-app-private.pem
openssl pkey -in school-app-private.pem -pubout -out school-app-public.pem
```

Classroom operator: put `school-app-public.pem` in `./secrets/` on the server and set
`SCHOOL_APP_JWT_PUBLIC_KEY_FILE=/app/secrets/school-app-public.pem` in `.env`
(or paste it into `SCHOOL_APP_JWT_PUBLIC_KEY` on one line with `\n` for the line
breaks). When a public key is configured, HS256 tokens are always refused.

**Fallback: HS256 shared secret** (`SCHOOL_APP_JWT_SECRET`, at least 32 random
bytes, e.g. `openssl rand -base64 48`). Only used when no public key is set. Both
sides hold the secret, so anyone with it can mint links. Use it only if you
cannot use a key pair.

Both sides also agree on:

| Classroom env | Meaning | Token claim |
|---|---|---|
| `SCHOOL_APP_JWT_ISSUER` (required) | e.g. `https://app.your-school.org` | `iss` must equal it |
| `SCHOOL_APP_JWT_AUDIENCE` (default `classroom`) | | `aud` must equal / contain it |
| `SCHOOL_APP_JWT_MAX_LIFETIME_SECONDS` (default 120) | max `exp − iat` | |
| `SCHOOL_APP_JWT_CLOCK_SKEW_SECONDS` (default 30) | tolerated clock difference | |

## 2. Token

Header: `{"alg":"EdDSA"}` (or `RS256` / `HS256`).

| Claim | Required | Notes |
|---|---|---|
| `sub` (or `studentId`) | yes | The school's **permanent, unique student ID** (letters, digits, `. _ : @ / -`, max 64). This is the identity key: the same student must always get the same value. If both are sent they must be equal. |
| `name` | yes | Display name (max 100) |
| `grade` | yes | e.g. `7` (`Grade 7`, `Std 7`, `VII`-style prefixes are normalised; send the plain value to be safe) |
| `division` | yes | e.g. `B` (upper-cased). Must be a single division |
| `rollNumber` | no | Display only (max 20) |
| `email`, `phone` | no | Stored, not required |
| `iss`, `aud` | yes | See table above |
| `iat` | yes | Issued-at (seconds) |
| `exp` | yes | `iat + 60` recommended; `exp − iat` may be at most 120 s |
| `jti` | yes | Random unique id (UUID). **Each token works once**; the classroom remembers used ids until they expire |

Mint a fresh token **every time** the student taps "Join class" — never cache
or embed a token in the app, and never sign tokens inside the mobile app.

### Node (jose)

```js
import { SignJWT, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const key = await importPKCS8(readFileSync('school-app-private.pem', 'utf8'), 'EdDSA');

export async function classroomJoinUrl(student) {
  const token = await new SignJWT({
    name: student.name,
    grade: String(student.grade),
    division: student.division,
    rollNumber: String(student.rollNumber ?? ''),
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(String(student.id))
    .setIssuer('https://app.your-school.org')
    .setAudience('classroom')
    .setIssuedAt()
    .setExpirationTime('60s')
    .setJti(randomUUID())
    .sign(key);
  return `https://class.your-school.org/join?t=${token}`;
}
```

### Python (PyJWT ≥ 2, `pip install pyjwt cryptography`)

```python
import time, uuid, jwt

PRIVATE_KEY = open("school-app-private.pem").read()

def classroom_join_url(student):
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": str(student.id),
            "name": student.name,
            "grade": str(student.grade),
            "division": student.division,
            "rollNumber": str(student.roll_number or ""),
            "iss": "https://app.your-school.org",
            "aud": "classroom",
            "iat": now,
            "exp": now + 60,
            "jti": str(uuid.uuid4()),
        },
        PRIVATE_KEY,
        algorithm="EdDSA",   # or "RS256"; "HS256" with the shared secret
    )
    return f"https://class.your-school.org/join?t={token}"
```

### Java (jjwt 0.12, Ed25519 needs Java 15+)

```java
PrivateKey key = /* load PKCS#8 PEM, KeyFactory.getInstance("Ed25519") or "RSA" */;
long now = System.currentTimeMillis();
String token = Jwts.builder()
    .subject(student.getId())
    .claim("name", student.getName())
    .claim("grade", student.getGrade())
    .claim("division", student.getDivision())
    .claim("rollNumber", student.getRollNumber())
    .issuer("https://app.your-school.org")
    .audience().add("classroom").and()
    .issuedAt(new Date(now))
    .expiration(new Date(now + 60_000))
    .id(UUID.randomUUID().toString())
    .signWith(key)            // EdDSA for Ed25519 keys, RS256 for RSA keys
    .compact();
String url = "https://class.your-school.org/join?t=" + token;
```

## 3. Opening the link

Open the URL in the **system browser engine with a real browser profile**, so
camera/microphone permissions, cookies and WebRTC work:

- **Android**: Chrome Custom Tabs (`androidx.browser:browser`,
  `CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))`).
- **iOS**: `SFSafariViewController` (or `ASWebAuthenticationSession`).
- Web app: a normal navigation / new tab.

Do **not** use a plain `WebView` / `WKWebView`: camera and mic permission
handling, the secure `__Host-` session cookie and WebRTC are unreliable there,
and the student may be signed out between taps.

The classroom answers with redirects only (no JSON); the token is consumed on
the first request and removed from the address bar.

## 4. What the student sees

| Situation | Page |
|---|---|
| A class for their grade-division is open (teacher started it, or its waiting room opened `WAITING_ROOM_EARLY_MINUTES` before the start; late joining allowed until the class ends) | That class's waiting room. The teacher admits them (no auto-admit). |
| A class later today | Countdown with subject, teacher and time; it moves on automatically when the waiting room opens |
| Nothing now | "No class right now" + the next scheduled class |
| Today's class already ended | "Class has ended" + the next one |

Combined classes (several divisions, or all divisions of a grade) and ad-hoc
classes a teacher starts for that grade-division are found the same way. A
student can never enter a class for another grade-division, even with a
teacher's code.

## 5. Errors

On any failure the student lands on `/student/error?reason=<code>` with a
friendly message telling them to go back to the school app and tap "Join
class" again:

| Code | Cause |
|---|---|
| `missing` / `malformed` | No `t` parameter / not a JWT |
| `bad_signature` | Wrong key or secret, unexpected `alg` (e.g. HS256 while a public key is configured, `none`) |
| `expired` | `exp` passed (beyond the clock-skew allowance) |
| `not_yet_valid` | `iat`/`nbf` in the future: check the server clock (NTP) |
| `wrong_issuer` / `wrong_audience` | `iss` / `aud` mismatch |
| `lifetime_too_long` | `exp − iat` greater than the maximum (120 s) |
| `replayed` | The `jti` was already used: mint a new token per tap |
| `bad_claims` | Missing/invalid `sub`, `name`, `grade`, `division` or `jti` |
| `not_configured` | The classroom has no issuer/key configured |
| `unavailable` | The classroom could not record the token id (Redis down); retry |

## 6. Testing without the school app

On a classroom checkout (dev only):

```bash
cd apps/web
node scripts/make-join-link.mjs --gen-keys ./join-test-keys   # prints SCHOOL_APP_JWT_PUBLIC_KEY=...
# put that line + SCHOOL_APP_JWT_ISSUER=test-school in the classroom env, restart, then:
node scripts/make-join-link.mjs --key ./join-test-keys/private.pem --iss test-school \
  --url http://localhost:3000 --student S1001 --name "Asha Patil" --grade 7 --division A --roll 12
```

Open the printed link within 60 s, once.

## 7. Attendance note

The classroom knows a student only after their first signed join, unless the
admin imports the roster (Admin → Students → CSV `externalId,name,grade,division,roll`,
where `externalId` = the same ID you send as `sub`). "Absent" in reports
counts only known students, so import the roster if you need complete absence
figures.
