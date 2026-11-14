# KonomiTV for Discord

自宅の [KonomiTV](https://github.com/tsukumijima/KonomiTV) で受信しているテレビ放送を、Discord のアクティビティとしてボイスチャンネルの中で見るためのアプリです。

- チャンネル一覧と放送中の番組を表示し、選んだチャンネルのライブ映像を再生します
- 誰かがチャンネルを変えると、同じアクティビティにいる全員が同じチャンネルに切り替わります（各自でオフにできます）
- 画質と音量は各自で変えられます
- データ放送（d ボタン）を表示して、画面上のリモコンやキーボードで操作できます
- 見られるのは、許可した Discord サーバーのメンバーか、許可したユーザーだけです

KonomiTV 本体には手を入れません。このアプリが KonomiTV の API とライブ映像を中継します。

## 仕組み

```
Discord クライアント ─ Discord のプロキシ (<アプリID>.discordsays.com)
        └─ 公開ホスト名 (Cloudflare Tunnel など)
              └─ このアプリ (127.0.0.1:7100) ─ KonomiTV (https://127-0-0-1.local.konomi.tv:7000)
```

| 場所 | 中身 |
|---|---|
| `server/index.mjs` | 中継サーバー。Discord の認証、視聴許可の判定、KonomiTV の中継、チャンネル同期 (WebSocket) |
| `client/` | 画面。Vite + TypeScript、再生は mpegts.js |

## 必要なもの

- KonomiTV が動いているマシン（Docker が使えること）
- 外から HTTPS で届く公開ホスト名（Cloudflare Tunnel など）
- Discord のアプリ（[Developer Portal](https://discord.com/developers/applications) で作る）

## セットアップ

### 1. Discord のアプリを作る

1. Developer Portal で「New Application」からアプリを作る
2. **OAuth2**: Client ID と Client Secret を控える。Redirects に `https://127.0.0.1` を追加して保存する
3. **Installation**: Installation Contexts の「User Install」と「Guild Install」を両方オンにする
4. **Activities > Settings**: 「Enable Activities」をオンにする
5. **Activities > URL Mappings**: Prefix `/` の Target に公開ホスト名（例: `tv-discord.example.com`、`https://` は付けない）を入れる

### 2. サーバーで起動する

```sh
git clone https://github.com/serkenn/KonomiTV-for-Discord.git
cd KonomiTV-for-Discord
cp .env.example .env
# .env を編集する
docker compose up -d --build
```

`.env` の項目:

| 項目 | 内容 |
|---|---|
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | 手順 1 で控えた値 |
| `ALLOWED_GUILD_IDS` | 視聴を許可する Discord サーバーの ID（カンマ区切り）。メンバー全員が見られる |
| `ALLOWED_USER_IDS` | 個別に許可するユーザーの ID（カンマ区切り） |
| `KONOMITV_URL` | KonomiTV の URL。同じマシンなら既定値のままでよい |

`ALLOWED_GUILD_IDS` と `ALLOWED_USER_IDS` が両方空のときは、全員を拒否します。ID は Discord の「開発者モード」をオンにして、サーバーやユーザーを右クリック →「ID をコピー」で取れます。

### 3. 公開ホスト名をこのアプリに向ける

公開ホスト名へのアクセスを `http://127.0.0.1:7100` に流します。Cloudflare Tunnel なら ingress にそのホスト名を足します。

このホスト名には **Cloudflare Access などのログイン画面を掛けないでください**。Discord のプロキシがログインできず、アクティビティが開けなくなります。代わりにこのアプリ自身が Discord のアカウントで視聴者を確かめます。

### 4. Discord で開く

ボイスチャンネルに入り、アクティビティ（ロケットのアイコン）から作ったアプリを選びます。公開審査を通していないアプリは、アプリの持ち主と Developer Portal のチームメンバーだけが起動できます。

## 知っておくこと

- **画質ごとにエンコードが 1 本走ります**。同じチャンネル・同じ画質の視聴者は 1 本を共有するので、みんなで 720p のままにしておくのが軽いです
- 再生には Media Source Extensions が必要です。PC 版 Discord とブラウザ版で動きます。モバイル版は端末によって再生できないことがあります
- データ放送は操作バーの「d」でリモコンを開くと読み込みます。操作は各自の画面だけに反映され、他の人とは同期しません。キーボードでは矢印・Enter・Backspace（戻る）・D・B/R/G/Y（色ボタン）・数字が使えます
- データ放送のうち、通信を使う機能（投票など）と郵便番号に依存する表示（地域の天気など）は動きません
- 録画番組の再生、実況コメント、字幕にはまだ対応していません
- テレビ放送を不特定の人に見せると著作権（公衆送信権）の問題になります。視聴を許可する範囲は自分と身内にとどめてください

## 開発

```sh
npm install && npm --prefix client install --allow-remote=all
npm run build
DEV_NO_AUTH=1 npm start   # http://127.0.0.1:7100 を普通のブラウザで開ける
```

`DEV_NO_AUTH=1` は Discord の認証を飛ばす開発用の設定で、`HOST=127.0.0.1` のときしか有効になりません。

データ放送の表示に使う [web-bml](https://github.com/otya128/web-bml) が、依存の 1 つを GitHub の配布ファイルから取得します。npm 12 以降は既定でこれを止めるので、`--allow-remote=all` が必要です。

## ライセンス

MIT License。データ放送の解読処理は KonomiTV（MIT License）の実装を移植したものです。`client/public/fonts/` の Kosugi / Kosugi Maru は Apache License 2.0 で配布されているフォントです。
KonomiTV は tsukumijima 氏によるソフトウェアで、このリポジトリは非公式の周辺ツールです。
