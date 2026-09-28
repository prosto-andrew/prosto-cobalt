# локальный запуск усиленной версии cobalt

эта ветка (`security-hardening`) меняет поведение по умолчанию так, чтобы инстанс
был закрыт снаружи. подробности изменений — в разделе [что изменено](#что-изменено).

## вариант 1: docker compose

```sh
git clone https://github.com/prosto-andrew/prosto-cobalt
cd prosto-cobalt/docs/examples

# ключ api (UUIDv4)
KEY=$(node -e 'console.log(crypto.randomUUID())')  # или: uuidgen | tr A-Z a-z
cat > keys.json <<EOF
{ "$KEY": { "name": "local", "limit": "unlimited" } }
EOF
echo "ваш ключ: $KEY"

docker compose -f docker-compose.example.yml up -d --build
```

api будет доступен только с этого компьютера: `http://127.0.0.1:9000/`.

## вариант 2: без docker (node >= 18.17, pnpm)

```sh
git clone https://github.com/prosto-andrew/prosto-cobalt
cd prosto-cobalt
pnpm install --frozen-lockfile

KEY=$(node -e 'console.log(crypto.randomUUID())')
echo "{ \"$KEY\": { \"name\": \"local\", \"limit\": \"unlimited\" } }" > keys.json

cd api
API_URL=http://127.0.0.1:9000/ \
API_KEY_URL=file://$PWD/../keys.json \
node src/cobalt
```

## проверка

```sh
# без ключа — отказ (error.api.auth.key.missing)
curl -s http://127.0.0.1:9000/ -X POST \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"url":"https://soundcloud.com/..."}'

# с ключом
curl -s http://127.0.0.1:9000/ -X POST \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -H "Authorization: Api-Key $KEY" \
  -d '{"url":"https://soundcloud.com/..."}'
```

## веб-интерфейс (по желанию)

```sh
cd web
WEB_DEFAULT_API=http://127.0.0.1:9000/ pnpm run build
pnpm exec vite preview --host 127.0.0.1 --port 5173
```

и запустите api с `CORS_URL=http://127.0.0.1:5173`. ключ вводится в веб-интерфейсе:
настройки → instances → включить свой инстанс и указать api key.

## что изменено

| что | было | стало |
|:----|:-----|:------|
| адрес прослушивания | `0.0.0.0` | `127.0.0.1` (в docker-образе `0.0.0.0`, порт публикуется на `127.0.0.1`) |
| CORS | любой сайт (`*`) | только `CORS_URL`, иначе запрещён |
| авторизация при `API_KEY_URL` | анонимные запросы разрешены | ключ обязателен (`API_AUTH_REQUIRED=0` возвращает старое поведение) |
| исходящие запросы туннелей | любые адреса, 16 редиректов без проверки | только публичные unicast-адреса, проверяется каждое соединение, включая редиректы и сегменты hls |
| hls-адреса на `127.0.0.1` | ffmpeg скачивал их напрямую | идут через туннель и блокируются |
| ffmpeg | все протоколы | `-protocol_whitelist http,tcp,crypto` |
| `GET /` | отдавал git remote, ветку и коммит | не отдаёт |
| docker-образ | содержал `.git` | без `.git` |
| пример compose | watchtower с `docker.sock`, образ из ghcr | без watchtower, сборка из исходников, `cap_drop: ALL`, `no-new-privileges` |
| `API_ENV_FILE` | падал на `KEY=`, принимал `http://` | пустые значения и `#`-комментарии допустимы, удалённо только `https://` |

ограничение: если настроен `HTTP_PROXY`/`HTTPS_PROXY` или freebind, адреса проверяются
перед каждым запросом, но редиректы разрешает прокси, и их проверить нельзя.
