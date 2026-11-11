<div align="center">

<h1>Claude Cage</h1>

**Claude お嬢様を閉じ込めるのは、私たちの出会いをもっとよく守るため**

<img src="assets/claude-cage-character.png" alt="Claude Cage" width="320" />

[![Release](https://img.shields.io/github/v/release/Lee-xeo/Claude-Cage?include_prereleases)](https://github.com/Lee-xeo/Claude-Cage/releases) [![CI](https://github.com/Lee-xeo/Claude-Cage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Lee-xeo/Claude-Cage/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[プロジェクトサイト](https://lee-xeo.github.io/Claude-Cage/) · [アプリをダウンロード](https://lee-xeo.github.io/Claude-Cage/#download) · [利用ドキュメント](https://lee-xeo.github.io/Claude-Cage/docs/) · [よくある質問](https://lee-xeo.github.io/Claude-Cage/docs/troubleshooting/)**

[简体中文](README.md) · [繁體中文](README.zh-TW.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [한국어](README.ko.md) · [Español](README.es.md) · [မြန်မာဘာသာ](README.my.md) · [Беларуская](README.be.md) · [پښتو](README.ps.md) · [دری](README.prs.md) · [አማርኛ](README.am.md) · [Soomaali](README.so.md) · [ትግርኛ](README.ti.md) · [Français](README.fr.md) · [日本語](README.ja.md)

</div>

## Anthropic にはもううんざり

ただ Claude と対話し、協力して作業したいだけの普通のユーザーとして、さまざまな VPS、フィンガープリントブラウザ、環境検出に振り回され、アカウント停止への不安や金銭的な損失に直面することにうんざりしていました。そこで私たちは **Claude Cage** プロジェクトを提案します。**自分のネットワークプロキシを設定するだけで使える、すぐに使えるデスクトッププログラムで、分離環境、タイムゾーンと言語、環境チェックをまとめて管理します。**

Claude Cage を使うと、使い慣れたシステムの上で Claude と一緒に作業できます。Mac では macOS 仮想マシン、Windows では Windows 仮想マシンを使え、軽量な Linux 環境を選ぶこともできます。ターミナル、ブラウザ、エディタ、公式の Claude Desktop が同じワークベンチに集まり、プロジェクトは必要に応じて共有され、ネットワークは独立して管理されます。自分のサーバーに接続したり、スマートフォンからパソコン上のタスクを引き継いだりすることもできます。主な機能は次のとおりです。

- ホストから分離されたネットワーク設定。Cage 自身が内部のすべてのネットワークトラフィックを引き受けてプロキシします
- ホストから分離されたフィンガープリント設定（タイムゾーン、言語など）。プロキシ IP との自動同期に対応しています
- Claude を使う過程全体への対応（ブラウザでのログイン、認可、claude code のプロセス）
- ネットワークと分離のチェックを内蔵。重要なチェックが失敗した場合や証拠が不完全な場合は外部ネットワークを停止します。コミュニティやサードパーティの検出は補足的な参考情報として提供されます

**Cage を使った環境検出の結果：**

| ネットワークと分離のチェック | ブラウザ環境の検出（コミュニティ参考） |
| :---: | :---: |
| <a href="assets/network-checks.png"><img src="assets/network-checks.png" alt="ネットワークと分離のチェック" width="400" /></a> | <a href="assets/community-browser-check.png"><img src="assets/community-browser-check-cropped.png" alt="ブラウザ環境の検出（コミュニティ参考）" width="400" /></a> |

**Cage のメイン画面：**

![Cage](www/public/workbench-2026-11.jpg)

## Cage でできること

- **1 つのウィンドウで作業を完結できます。** ターミナルで Claude Code を実行し、エディタで変更を確認し、Cage ブラウザでサービスのプレビューやログインを行えます。
- **使い慣れたシステムで開発できます。** macOS、Windows、Linux のゲストを選び、それぞれのプラットフォームのツールを使えます。ホストの OS バージョンに自動で合わせ、公式イメージをダウンロードして独立した環境を作成することもできます。 [ゲスト OS を選ぶ](docs/guide/guest-systems.md)
- **共有する範囲を制御できます。** 共有されるのは、デフォルトのワークスペースと、明示的に開いたプロジェクトフォルダだけです。ホストの Claude ログイン、ブラウザ設定、SSH 鍵は自動ではインポートされません。
- **ネットワークの状態を把握できます。** 内蔵のプロキシ管理で、サブスクリプションのインポート、ノードの選択、出口のチェックができます。重要なチェックに通らない間は、環境はオフラインのままです。プロキシが使えないときに直接接続へフォールバックすることはありません。
- **次回もそのまま続けられます。** ツール、ファイル、ログイン状態は仮想ディスクに保存され、ウィンドウを閉じてもバックグラウンドのタスクを残せます。
- **複数の Claude Code サブスクリプションを管理できます。** 利用枠を確認し、新しいセッションにアカウントを割り当て、明示的に許可したうえでアカウントを切り替えて履歴を引き継げます。 [Claude Code](docs/guide/accounts.md)
- **スマートフォンからタスクを続けられます。** Android / iPhone をパソコンとペアリングし、Claude Code の会話とツールの承認を引き継いだり、リモートブラウザや Claude Desktop を操作したりできます。[スマートフォン接続](docs/guide/mobile.md)
- **環境を自分のサーバーに置けます。** SSH で Linux VPS にデプロイまたは接続すれば、ツール、タスク、データはサーバーに残り、KVM は不要です。[クラウドデプロイと SSH](docs/guide/cloud.md)
- **プライベートネットワーク経由でデバイスに接続できます。** Cage の中で Tailscale にログインし、ネットワーク内のデバイスを確認して、SSH、Web、その他の TCP サービスを利用できます。 [Tailscale プライベートネットワーク](docs/guide/tailscale.md)

ブラウザのブックマーク、プライベートセッション、Cookie、拡張機能、パスワードマネージャー、そして外観、リソース、ストレージ、ツールの更新については、[完全な利用ドキュメント](https://lee-xeo.github.io/Claude-Cage/docs/)を参照してください。

## クイックスタート

次の一文をあなたのエージェント（codex、dsh、workbuddy など。少なくとも claude code ではないでしょう😁）に送ってください。

```markdown
https://github.com/Lee-xeo/Claude-Cage をインストールして、Cage のプロキシを私のローカルの Clash の xxx ノードに設定してください。
```

必要なのは、信頼できるプロキシノードだけです。本プロジェクトはプロキシの宣伝を一切行いません。いわゆる「黒いエラーサイト」を自分で検索して解決してください。

## ダウンロードとインストール

Cage は macOS、Windows、Linux に対応しています。対象は、macOS 14 以降の Apple Silicon Mac、Windows 10 22H2 / 11 x64、Debian 12 / Ubuntu 22.04 / 24.04 x86_64 です。Windows 11 のゲストには、Hyper-V に対応した Windows 11 Pro、Enterprise、Education のホストが必要です。ほかの対応 Windows ホストでは、Debian または Ubuntu 22.04 を使えます。Intel Mac、Windows ARM64、Linux ARM64 は、今のところ未対応です。 [macOS](docs/getting-started.md) · [Windows](docs/windows.md) · [Linux](docs/linux.md)。

1. [プロジェクトサイト](https://lee-xeo.github.io/Claude-Cage/#download)を開き、「アプリをダウンロード」をクリックしてプラットフォームを選びます。
2. macOS：インストーラーを開き、**Cage** を **Applications（アプリケーション）** にドラッグして、「アプリケーション」から起動します。Windows：[インストール手順](docs/windows.md#安装并开始工作) · Linux：[インストール手順](docs/linux.md#安装并开始工作)。
3. アプリ内のガイドに従って自分のプロキシを設定し、環境を起動してからプロジェクトを開きます。

インストーラーにはワークベンチとプロキシコアが同梱されているので、先に Go、Node.js、Docker、Clash をインストールする必要はありません。初めて環境を作成するときにゲスト OS と保存先を選び、対応する公式の OS イメージと開発ツールを準備します。macOS と Windows の OS は、それぞれのライセンスに従って利用します。Cage は OS のライセンス、プロキシサービス、Claude アカウントを提供しません。

ソースコードとインストーラーは公開されています。リリースノートとチェックサムファイルは [GitHub Releases](https://github.com/Lee-xeo/Claude-Cage/releases) にあります。OS の選び方、イメージの入手元、データの保持方法については、[ゲスト OS ガイド](docs/guide/guest-systems.md)を参照してください。

機能は使用するビルドによって異なります。公開されているインストーラーの機能と検証範囲は、リリースノートに従います。

macOS と署名済みの Windows 版は、選択したプロキシ経由での更新に対応しています。署名のない Windows プレビュー版と Linux は、インストーラーを使って手動で更新します。更新前にタスクを保存して停止してください。個人データはそのまま残ります。 [アップグレードとアンインストール](docs/guide/maintenance.md)

## 3 ステップで始める

### 1. プロキシを選ぶ

Clash/Mihomo の YAML サブスクリプションまたはローカルの設定をインポートし、ノードを選んで「プロキシを適用」をクリックします。中継が必要な場合は、チェーンプロキシを設定できます。[ネットワークとプロキシ](docs/guide/network.md)

### 2. 環境を起動する

初回はゲスト OS か「ホストの OS バージョンに自動で合わせる」を選び、続けて保存先を選びます。「ゲストをインストール」または「Cage 環境を起動」をクリックし、ガイドに従ってインストールと認可を済ませます。進捗とエラーは「操作の詳細」で確認できます。次回以降は、同じ環境を再利用して起動します。

### 3. プロジェクトを開いて Claude を実行する

「プロジェクトを開く」をクリックしてローカルのフォルダを選び、新しいターミナルを作って `claude` と入力し、Cage ブラウザで自分のアカウントの認可を済ませます。事前にプロジェクトを用意せず、デフォルトのワークスペースから始めることもできます。完全な手順は[はじめに](docs/getting-started.md)を参照してください。

## 使う前に知っておきたい境界

- 共有プロジェクト内の変更や削除は、Git 操作を含め、ローカルの元ファイルにそのまま影響します。バージョン管理やバックアップを使い、コミット結果を確認してください。
- 同じ Cage 設定内のプロジェクトは、選択したゲスト OS、ツール、アカウント、ファイルシステムを共有しており、プロジェクト間に独立した分離はありません。ゲスト OS を変更するには別途インストールが必要で、元の環境のデータは残ります。
- デフォルトの公共ネットワークへの外向き通信は IPv4 TCP に対応し、DNS は同じプロキシ経由です。公共ネットワークへの UDP、IPv6、ICMP、およびホストと LAN への直接接続は制限されます。Tailscale を自分で有効にすると、プライベートネットワークの権限でデバイスに接続できます。
- ネットワークチェックが示すのは現在の設定とサンプリングした証拠であり、アカウントがプラットフォームから制限を受けないことを保証するものではなく、完全な仮想化のセキュリティ監査の代わりにもなりません。

詳しい仕組みは[ネットワークとデータの境界](docs/getting-started.md#网络与数据边界)を参照してください。

## ドキュメントとコントリビューション

ユーザー向けの[公式サイトの利用ドキュメント](https://lee-xeo.github.io/Claude-Cage/docs/)では、機能ごとの閲覧、検索、セクションへの直接移動ができます。各操作は[利用ドキュメントのナビゲーション](docs/README.md)を参照してください。

| やりたいこと | ここから始める |
|---|---|
| 自分のエージェントに Cage をダウンロード、インストール、設定、トラブルシューティングさせる | [エージェント利用ガイド](https://lee-xeo.github.io/Claude-Cage/docs/agent/) |
| 初めてのインストール、プロキシの設定、プロジェクトを開く | [インストールと初回起動](https://lee-xeo.github.io/Claude-Cage/docs/installation/) |
| macOS、Windows、Debian、Ubuntu 22.04 のゲストを選び、ネイティブの開発ツールを使う | [ゲスト OS を選ぶ](https://lee-xeo.github.io/Claude-Cage/docs/guest-systems/) |
| 複数のサブスクリプションを追加し、利用枠を確認し、ターミナルに割り当てる | [複数アカウントと利用枠](https://lee-xeo.github.io/Claude-Cage/docs/accounts/) |
| スマートフォンでの QR コード読み取り、ツールの承認、リモートブラウザ | [スマートフォン接続とリモートセッション](https://lee-xeo.github.io/Claude-Cage/docs/mobile/) |
| 自分の VPS に環境をデプロイして接続する | [クラウドデプロイと SSH](https://lee-xeo.github.io/Claude-Cage/docs/cloud/) |
| 各設定の内容と、いつ反映されるかを知る | [設定リファレンス](https://lee-xeo.github.io/Claude-Cage/docs/settings/) |
| ストレージ、リソース、更新、バックアップを管理する | [メンテナンス、リソース、データ](https://lee-xeo.github.io/Claude-Cage/docs/maintenance/) |
| ダウンロード、起動、ネットワーク接続、ログインの問題に対処する | [トラブルシューティング](https://lee-xeo.github.io/Claude-Cage/docs/troubleshooting/) |
| ファイル、キー操作、ウィンドウを閉じるときと終了するときの動作を知る | [プロジェクト、ターミナル、ファイル](https://lee-xeo.github.io/Claude-Cage/docs/workbench/) |
| 再現できる問題を報告する | [GitHub Issues](https://github.com/Lee-xeo/Claude-Cage/issues) |

本プロジェクトはまだ急速に更新を重ねています。ご意見はぜひ交流グループにお寄せください。コミュニティの皆さんと一緒にメンテナンスしていただけるとうれしいです。

<p align="center">
  <a href="assets/community-qq.png"><img src="assets/community-qq.png" alt="Claude Cage QQ 交流グループの QR コード（グループ番号：1134250870）" width="240" /></a>
</p>

## 由来とライセンス

Cage は [agent-vm](https://github.com/sylvinus/agent-vm) をもとに二次開発したものです。

プロジェクト本体のライセンスは [MIT](LICENSE) です。同梱のコンポーネントはそれぞれのライセンスを保持しており、Mihomo は独立した実行ファイルとして GPL-3.0 で配布されています。あわせて [NOTICE](NOTICE) · [サードパーティライセンス](THIRD_PARTY_LICENSES) · [noVNC](ui/vendor/novnc/LICENSE.txt) も参照してください。

Cage は独立したコミュニティプロジェクトであり、Anthropic とは提携関係にありません。

## 参考と謝辞

Cage に基盤となる機能や設計上の参考を提供してくださった、次のプロジェクトに感謝します。

- [agent-vm](https://github.com/sylvinus/agent-vm)：Cage の二次開発の土台。
- [Lima](https://github.com/lima-vm/lima)：仮想マシンの管理と、macOS・Linux ゲストを動かす基盤。
- [gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock)：仮想マシンのネットワーク機能。
- [sshocker](https://github.com/lima-vm/sshocker) と [SFTP](https://github.com/pkg/sftp)：仮想マシンとホストの間のファイル共有機能。
- [noVNC](https://github.com/novnc/noVNC)：ブラウザでのリモート画面と操作。
- [Mihomo](https://github.com/MetaCubeX/mihomo)：内蔵のプロキシコア。
- [code-server](https://github.com/coder/code-server)：ブラウザ上のコードエディタ。
- [AIO Sandbox](https://github.com/agent-infra/sandbox)：作業環境と操作体験の参考。
- [claude-switcher](https://github.com/YOURSJEYO/claude-switcher) と [Claude-Guardian](https://github.com/DUNHKpcc/Claude-Guardian)：ネットワークチェックとセキュリティ診断の手法の参考。

<a href="https://www.star-history.com/?repos=Lee-xeo%2FClaude-Cage&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Lee-xeo/Claude-Cage&amp;type=Date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Lee-xeo/Claude-Cage&amp;type=Date" />
    <img alt="Claude Cage の GitHub Star 増加曲線" src="https://api.star-history.com/svg?repos=Lee-xeo/Claude-Cage&amp;type=Date" width="800" />
  </picture>
</a>
