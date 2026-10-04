# локальный запуск усиленной версии cobalt

ветка `custom` этого форка меняет поведение по умолчанию так, чтобы инстанс
был закрыт снаружи. ветка `main` — чистая копия оригинального cobalt, без этих правок.
подробности изменений — в разделе [что изменено](#что-изменено).

## вариант 1: docker compose

```sh
git clone -b custom https://github.com/prosto-andrew/prosto-cobalt
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
git clone -b custom https://github.com/prosto-andrew/prosto-cobalt
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
export WEB_DEFAULT_API=http://127.0.0.1:9000/   # нужен и для build, и для preview
pnpm run build
pnpm exec vite preview --host 127.0.0.1 --port 5173
```

`vite preview` работает только по **https** с самоподписанным сертификатом
(плагин `@vitejs/plugin-basic-ssl`): откройте `https://127.0.0.1:5173/` и примите
предупреждение браузера. поэтому api запускайте с `CORS_URL=https://127.0.0.1:5173`
(именно `https`, без `/` в конце). ключ вводится в веб-интерфейсе:
настройки → instances → включить свой инстанс и указать api key.

ключ хранится в `localStorage` браузера в открытом виде и попадает в файл
экспорта настроек (настройки → advanced → export) — не делитесь этим файлом.

## обновление из оригинального cobalt

1. на github откройте форк, переключитесь на ветку `main` и нажмите **Sync fork**.
2. влейте обновления в `custom`:

```sh
cd prosto-cobalt
git checkout custom
git pull
git fetch origin main
git merge origin/main   # при конфликтах — решить, затем git commit
git push
```

3. перезапустите инстанс:
   - docker: `docker compose -f docs/examples/docker-compose.example.yml up -d --build`;
   - без docker: `pnpm install --frozen-lockfile`, затем запустите api так же, как в варианте 2.

## что изменено

| что | было | стало |
|:----|:-----|:------|
| адрес прослушивания | `0.0.0.0` | `127.0.0.1` (в docker-образе `0.0.0.0`, порт публикуется на `127.0.0.1`) |
| CORS | любой сайт (`*`) | только `CORS_URL`, иначе запрещён |
| авторизация при `API_KEY_URL` | анонимные запросы разрешены | ключ обязателен (`API_AUTH_REQUIRED=0` возвращает старое поведение) |
| исходящие запросы туннелей | любые адреса, 16 редиректов без проверки | только публичные unicast-адреса, проверяется каждое соединение, включая редиректы и сегменты hls |
| hls-адреса на `127.0.0.1` | ffmpeg скачивал их напрямую | идут через туннель и блокируются |
| ключи hls (`EXT-X-KEY`), субтитры hls | ffmpeg скачивал их напрямую | идут через туннель |
| ffmpeg | все протоколы, любые адреса | `-protocol_whitelist http,tcp,crypto`; все http-запросы ffmpeg идут через обработчик внутренних туннелей (`http_proxy`), поэтому адреса из dash-манифестов, редиректов и т. п. недоступны |
| туннели через `HTTP_PROXY`/`HTTPS_PROXY` и freebind | проверялся только первый адрес | проверяется каждый запрос и каждый редирект; запросы в обход прокси (`NO_PROXY`) — при соединении |
| `GET /` | отдавал git remote, ветку и коммит | не отдаёт |
| docker-образ | содержал `.git` | без `.git` |
| пример compose | watchtower с `docker.sock`, образ из ghcr | без watchtower, сборка из исходников, `cap_drop: ALL`, `no-new-privileges` |
| `API_ENV_FILE` | падал на `KEY=`, принимал `http://` | пустые значения и `#`-комментарии допустимы, удалённо только `https://` |

ограничения:

- если настроен `HTTP_PROXY`/`HTTPS_PROXY` или freebind, каждый запрос и редирект
  проверяется локальным dns перед отправкой, но потом адрес заново разрешает прокси
  (или freebind). если dns-ответ меняется между проверкой и соединением
  (dns rebinding), это не заметить.
- vpn- и прокси-клиенты в режиме «fake-ip» (dns отвечает адресами из `198.18.0.0/15`)
  ломают все туннели: такие адреса считаются непубличными. запускайте cobalt там,
  где dns отдаёт настоящие адреса.
- запросы обработчиков сервисов к api самих сервисов (youtube, vimeo и т. д.) идут
  без этой проверки — адреса в них задаёт cobalt или сам сервис.
