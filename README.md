# AWS S3 cu LocalStack

Prototip pentru serviciul **Amazon S3** rulat local cu LocalStack. Aplicația este o mică „arhivă de documente”: creez un bucket, încarc fișiere, le listez, le descarc, generez un link temporar (presigned URL), folosesc versionarea și la final șterg datele.

Operațiunile se pot face în două feluri:
- cu un script Node.js (`src/cli.js`), care folosește AWS SDK v3
- cu `awslocal` (AWS CLI pentru LocalStack, care e deja inclus în containerul LocalStack)

## Cerințe

- Docker Desktop (cu Docker Compose)
- Node.js 20 sau mai nou
- Git
- Cont gratuit LocalStack și un auth token (de la release-ul 2026.03.0 LocalStack nu mai pornește fără token)

## Instalare

```bash
git clone https://github.com/davosab/aws-s3-localstack.git
cd aws-s3-localstack
npm install
```

## Configurare

1. Fă-ți cont pe https://app.localstack.cloud și copiază tokenul din **Settings → Auth Tokens**.
2. Creează fișierul `.env` pornind de la exemplu:

```bash
cp .env.example .env
```

3. Deschide `.env` și pune tokenul:

```
LOCALSTACK_AUTH_TOKEN=ls-xxxx...
```

Fișierul `.env` este în `.gitignore`, deci tokenul nu ajunge pe GitHub.

Alte setări:
- `docker-compose.yml` pornește doar serviciul S3 (`SERVICES=s3`) pe portul `4566`. Folderele `samples/` și `downloads/` sunt montate în container la `/work`.
- `src/config.js` conectează SDK-ul la `http://localhost:4566` cu credențialele `test` / `test` (LocalStack acceptă orice credențiale) și `forcePathStyle: true`.
- Bucketul folosit este `docs-archive`.

## Pornire LocalStack

```bash
docker compose up -d
```

Verificare (în PowerShell scrie `curl.exe` în loc de `curl`):

```bash
curl http://localhost:4566/_localstack/health
```

În răspuns trebuie să apară `"s3": "available"`.

## Utilizare cu Node.js

Lista comenzilor:

```bash
node src/cli.js help
```

### Creare

```bash
node src/cli.js create-bucket
node src/cli.js buckets
```

```
Bucket created: docs-archive
2026-11-16T21:04:35.000Z  docs-archive
```

### Inserare (upload)

```bash
node src/cli.js upload samples/invoice.pdf invoices/2026/invoice.pdf
node src/cli.js upload samples/notes-v1.txt notes/readme.txt
```

```
Uploaded samples/invoice.pdf -> s3://docs-archive/invoices/2026/invoice.pdf (0.7 KB)
Uploaded samples/notes-v1.txt -> s3://docs-archive/notes/readme.txt (0.1 KB)
```

### Citire

Listare (toate fișierele sau doar cele dintr-un „folder”, adică un prefix):

```bash
node src/cli.js list
node src/cli.js list invoices/
```

```
2026-11-16T21:04:36.000Z      0.7 KB  invoices/2026/invoice.pdf
2026-11-16T21:04:36.000Z      0.1 KB  notes/readme.txt
2 object(s) under "/"
```

Metadate:

```bash
node src/cli.js info invoices/2026/invoice.pdf
```

Descărcare (fișierul ajunge în `downloads/invoices/2026/invoice.pdf`):

```bash
node src/cli.js download invoices/2026/invoice.pdf
```

### Consumare prin link temporar (presigned URL)

```bash
node src/cli.js presign invoices/2026/invoice.pdf 60
```

Linkul afișat se deschide în browser și funcționează 60 de secunde, fără credențiale. După ce expiră, dă `AccessDenied`.

### Versionare

```bash
node src/cli.js enable-versioning
node src/cli.js upload samples/notes-v1.txt notes/meeting.txt
node src/cli.js upload samples/notes-v2.txt notes/meeting.txt
node src/cli.js versions notes/meeting.txt
```

```
* latest  AaHmLjPpThnVJ.EdzaZri_6MXKBUZO5l      0.1 KB  2026-11-16T21:05:50.000Z  version
          AaHmLjPoUDTlC7pJk12.gFJt1KhYC25g      0.1 KB  2026-11-16T21:05:50.000Z  version
```

Restaurare la versiunea veche (copiezi ID-ul de pe linia a doua din output-ul tău):

```bash
node src/cli.js restore notes/meeting.txt <id-versiune-veche>
node src/cli.js download notes/meeting.txt
```

Acum `downloads/notes/meeting.txt` conține iar „Meeting notes - version 1”.

### Ștergere

```bash
node src/cli.js delete notes/meeting.txt
node src/cli.js delete-bucket
```

```
Deleted s3://docs-archive/notes/meeting.txt
Removed 6 object version(s) and deleted bucket docs-archive
```

`delete-bucket` șterge întâi toate fișierele (și versiunile vechi), pentru că S3 nu șterge un bucket care nu e gol.

## Utilizare cu awslocal

În PowerShell îmi fac o scurtătură (o singură dată pe terminal):

```powershell
function awslocal { docker compose exec -w /work localstack awslocal @args }
```

În bash: `alias awslocal="docker compose exec -w /work localstack awslocal"` (în Git Bash trebuie rulat înainte și `export MSYS_NO_PATHCONV=1`).

```bash
# creare
awslocal s3 mb s3://docs-archive
awslocal s3 ls

# inserare
awslocal s3 cp samples/invoice.pdf s3://docs-archive/invoices/2026/invoice.pdf
awslocal s3 sync samples/ s3://docs-archive/samples/

# citire
awslocal s3 ls s3://docs-archive --recursive
awslocal s3api head-object --bucket docs-archive --key invoices/2026/invoice.pdf
awslocal s3 cp s3://docs-archive/invoices/2026/invoice.pdf downloads/invoice.pdf

# link temporar (5 minute)
awslocal s3 presign s3://docs-archive/invoices/2026/invoice.pdf --expires-in 300

# ștergere
awslocal s3 rm s3://docs-archive/invoices/2026/invoice.pdf
awslocal s3 rb s3://docs-archive --force
```

Dacă ai activat versionarea pe bucket, `rb --force` dă eroarea `BucketNotEmpty` (versiunile vechi rămân). În cazul ăsta folosește `node src/cli.js delete-bucket`.

## Oprire

```bash
docker compose down
```

Datele din S3 se pierd la oprire (persistența nu e activată).

## Probleme întâlnite

- `required variable LOCALSTACK_AUTH_TOKEN is missing a value`: lipsește `.env` sau tokenul din el.
- `Cannot reach LocalStack on http://localhost:4566`: LocalStack nu e pornit (`docker compose up -d`).
- `Bucket docs-archive does not exist`: rulează întâi `node src/cli.js create-bucket`.
- `port is already allocated`: alt container folosește portul 4566 (`docker ps`).

## Bibliografie

- https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html
- https://docs.localstack.cloud/aws/services/s3/
- https://docs.localstack.cloud/aws/getting-started/auth-token/
