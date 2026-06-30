# テナントの codex home 分離

leuco はテナントごとに `~/.leuco/projects/<id>/.codex/` を作り、`CODEX_HOME` をそこに向けている。複雑に見えるが、これは codex の config 構造に由来する不可避の選択。

## なぜ home を分けるのか

各テナントの `config.toml` で物理的に違う値が要求される箇所がある。

`mcp_servers.leuco.url` がテナントごとに異なる。leuco gateway は `http://127.0.0.1:PORT/mcp/<project_id>` のように URL パスに project_id を埋め込んで dispatch しており、テナント識別がここに乗っている。

`mcp_servers.<extra>` はプロジェクトごとに登録される追加 MCP サーバで、名前空間が衝突しうる。プロジェクト A の `foo` とプロジェクト B の `foo` が別物を指す可能性がある。

これらを 1 つの `config.toml` に共存させることはできない。codex の `mcp_servers` は top-level の単一テーブルで、profile スコープも project スコープも持たない。

## 試したが棄却した方向

profile と model_instructions_file で寄せる案を検討したが、profile が吸収できるのは model 系設定と approval_policy / sandbox_mode までで、mcp_servers は対象外。本質の複雑さは解消しない。

workspace 直下に `.codex/config.toml` を置いて isolated フラグで切り替える案も検討したが、codex の設定読み込みは `$CODEX_HOME/config.toml` 固定で、workspace 側の config は読まれない。書いたファイルが死に設定になるだけだった。

## 簡素化したい場合の唯一の道

home 分離を本当に外したいなら、gateway を作り変える必要がある。

gateway を単一 MCP URL（`http://127.0.0.1:PORT/mcp`）にし、テナント識別を URL パスではなく bearer token に寄せる。各 codex 子に異なる `LEUCO_MCP_TOKEN` を渡し、gateway 側で token から project_id を解決する。これで `mcp_servers.leuco` の中身がテナント間で同一になり、`~/.codex/config.toml` を共有できる。

ただし extra MCP サーバの扱いが残る。命名衝突を許容できないので、グローバル `~/.codex/config.toml` で利用者に手動定義してもらうか、leuco MCP 経由でプロキシする実装に寄せる必要がある。

[[isolated-flag-rejected]] という形でフラグ追加を試みたが、上記の理由で middle ground にならないため取り下げた。
