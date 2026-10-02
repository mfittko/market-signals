# api_origins: the origins the launchd API trusts. The console serves on MS_CONSOLE_PORT, and the Next proxy
# forwards the browser Origin unchanged. Port 3000 is not listed: an unrelated dev server there must not pass.
api_origins() {
  local cp="${MS_CONSOLE_PORT:-3737}"
  echo "${MS_ALLOWED_ORIGINS:-localhost:$cp,127.0.0.1:$cp}"
}
