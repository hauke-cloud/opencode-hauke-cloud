<!-- llm-readme-management spec=1 commit=8da1634c1c4dca95df2f2795031b555e5d20f75b template=default model=qwen3.8-27b-q4 digest=598d66067ca0 generated=2026-10-12T10:37:11Z -->
<a href="https://hauke.cloud" target="_blank"><img src="https://img.shields.io/badge/home-hauke.cloud-brightgreen" alt="hauke.cloud" style="display: block;" /></a>
<a href="https://github.com/hauke-cloud" target="_blank"><img src="https://img.shields.io/badge/github-hauke.cloud-blue" alt="hauke.cloud Github Organisation" style="display: block;" /></a>
<a href="https://github.com/hauke-cloud/llm-readme-management" target="_blank"><img src="https://img.shields.io/badge/template-default-orange" alt="Repository type - default" style="display: block;" /></a>


# Opencode Hauke Cloud


<img src="https://raw.githubusercontent.com/hauke-cloud/.github/main/resources/img/organisation-logo-small.png" alt="hauke.cloud logo" width="109" height="123" align="right">


<llm header>

This is an opencode v2 plugin (TypeScript) that adds OIDC sign-in, model discovery, and mem0 long-term memory to the opencode AI-coding CLI. If you use opencode and want to connect it to the hauke.cloud stack or a self-hosted equivalent, this is the one-line plugin you add to `opencode.json`.

</llm>


## :book: Description

<llm description>

`opencode-hauke-cloud` is a plugin for the [opencode](https://opencode.ai) AI-coding CLI (v2 plugin API). It lets you sign in to the hauke.cloud stack with a single `opencode auth login hauke-cloud` command and immediately use its model endpoint and long-term memory service, without managing tokens, API keys, or separate configuration files.

The plugin registers one provider (default id `hauke-cloud`) backed by an OpenAI-compatible endpoint, handles the full OAuth 2.0 authorization-code + PKCE flow against a Keycloak issuer, and wires mem0 memory tools into your opencode session. All options are optional; a bare `"plugin": ["opencode-hauke-cloud"]` entry in `opencode.json` is a complete setup.

- OIDC sign-in via a browser-based PKCE flow with automatic background token refresh (no client secret stored)
- Model discovery from the endpoint's `/models` listing, with per-model capability and limit overrides via glob patterns
- Four mem0 memory tools (`memory_search`, `memory_add`, `memory_list`, `memory_delete`) plus automatic recall into the system prompt and background capture of conversation context

The plugin is the opencode-facing entry point into the hauke.cloud infrastructure (Keycloak at `id.hauke.cloud`, llama-swap at `llama.llm.hauke.cloud`, mem0 at `mem0.llm.lab.hauke.cloud`), though every endpoint and identifier is overridable for a different deployment.

</llm>


## 🚀 Getting started

<llm getting_started hint="Assume nothing about the ecosystem beyond what the analysis names. If the repository has no build step, say what a reader does with it instead.">

1. Clone the repository and enter the working directory.

```bash
git clone https://github.com/hauke-cloud/opencode-hauke-cloud.git
cd opencode-hauke-cloud
```

2. Install the TypeScript dev dependencies.

```bash
npm install
```

3. Compile the plugin source to `dist/`.

```bash
npm run build
```

4. Run the full test suite (43 unit tests via Node's built-in runner).

```bash
npm test
```

A passing run confirms the plugin compiles cleanly and all modules behave as expected. To use the plugin in an opencode session, add `"opencode-hauke-cloud"` to the `plugin` array in your `opencode.json` and sign in with `opencode auth login hauke-cloud`.

</llm>


## :airplane: Usage

<llm usage>

Once opencode resolves the plugin from npm, three things cover most of your work.

**Configure the plugin in `opencode.json`.** The bare form is a complete setup when the defaults match your deployment:

```json
{
  "plugin": ["opencode-hauke-cloud"]
}
```

Use the tuple form to override endpoints or tune behaviour:

```json
{
  "plugin": [
    ["opencode-hauke-cloud", {
      "baseURL": "https://llama.llm.hauke.cloud/v1",
      "issuer": "https://id.hauke.cloud/realms/cloud",
      "memory": {
        "baseURL": "https://mem0.llm.lab.hauke.cloud",
        "recallLimit": 6,
        "captureMinChars": 20
      }
    }]
  ]
}
```

All options are optional.

**Sign in.** With port 51121 free, run:

```bash
opencode auth login hauke-cloud
```

Your browser opens to the Keycloak authorization page (OAuth 2.0 authorization-code + PKCE S256). After you approve, the loopback listener on `127.0.0.1:51121/callback` captures the redirect. Confirm with `opencode auth list`. Access tokens refresh in the background via the `refresh_token` grant; you do not re-authenticate until the refresh token is revoked.

**Use the memory tools.** Four tools are available in every session: `memory_search`, `memory_add`, `memory_list`, and `memory_delete`. Relevant memories are recalled into the system prompt once per user message, and messages of 20 or more characters are captured in the background. You can also call them explicitly, for example to store a project-scoped note:

> memory_add (scope: project): "The API gateways check the `aud` claim for both llama-swap and mem0 audiences."

Memories are tagged with the `owner/repo` read from your git `origin` remote.

</llm>


## 📄 License

This Project is licensed under the GNU General Public License v3.0

- see the [LICENSE](LICENSE) file for details.


## :coffee: Contributing

To become a contributor, please check out the [CONTRIBUTING](CONTRIBUTING.md) file.


## :email: Contact

For any inquiries or support requests, please open an issue in this
repository or contact us at [contact@hauke.cloud](mailto:contact@hauke.cloud).
