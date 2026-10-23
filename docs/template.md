# Personal-context directory template

Version 0.2.0 connects the bridge to a reusable personal-context directory structure. The earlier organization is retained as a clean template, with three core files, numbered topic directories, a record guide, local `AGENTS.md`, and six blank record templates. It does not distribute a person's filled archive or infer facts from folder names.

Both supported installers initialize the template in `dataDir/knowledge` after copying the runtime. You can also initialize or inspect it without credentials or network access:

```text
node bin/cli.mjs template init --config CONFIG_PATH
node bin/cli.mjs template map --config CONFIG_PATH
```

Replace `CONFIG_PATH` with the actual config path. To choose a different local destination, append `--directory ABSOLUTE_DIRECTORY`. `template init` returns created/skipped relative paths and the destination. Existing files are preserved, including edited core files; repeated initialization fills missing template files. It does not follow symlinks or permit path traversal.

## Generic layout

```text
knowledge/
  PROFILE.md
  PREFERENCES.md
  CURRENT.md
  README.md
  AGENTS.md
  记录规范.md
  00-收件箱/
  01-个人与人生/
  02-价值观与目标/
  03-家庭与亲密关系/
  04-亲友与社交/
  05-身心健康/
  06-职业与工作/
  07-财务与资产/
  08-学习与知识/
  09-兴趣与创作/
  10-居住与家务/
  11-饮食与日常/
  12-出行与旅行/
  13-数字生活与设备/
  14-法律证件与行政/
  15-项目与行动/
  16-日记与人生记录/
  17-决策与经验/
  90-模板/                         # six blank record templates
  99-归档/
```

The shipped files also provide generic subdirectories and instructions for records. The six blank formats retain the earlier names: `通用记录.md`, `项目.md`, `决策.md`, `人物.md`, `日记与复盘.md`, and `服务与账号索引.md`. They live under `90-模板/`, alongside a navigation `README.md`; the three core files remain separate at the knowledge root. Read the initialized `README.md` and `记录规范.md` for conventions. Categories such as family, health, or assets are optional organizational headings, not claims that any information exists about the user. Blank fields and examples must not be promoted to confirmed facts.

`服务与账号索引.md` is for non-sensitive service entry points and a reference to where credentials are managed. Do not fill it with passwords, tokens, private keys, or other credential contents.

The template's `AGENTS.md` guides work within the local knowledge directory. It is separate from the installer's optional `AGENTS.fragment.md` and does not automatically become a global Codex instruction or activate hooks/MCP.

## Local paths, resources, and native memories

| Layer | Role | Created by initialization? |
| --- | --- | --- |
| Local `knowledge/` | Human-editable Markdown organization and blank record formats | Missing local template files only |
| `viking://user/<user>/resources/personal-context/` | Remote resource hierarchy to which relative local paths can correspond | No |
| `viking://user/<user>/memories/` | Native short memories extracted from explicitly approved summaries | No |

`template map` emits JSON with the template version, absolute local root, configured resource root, native memory root, and core-file/topic-directory mappings. For example, relative `PROFILE.md` corresponds to the configured resource root plus `PROFILE.md`. Use the actual returned mapping rather than guessing URI encoding or an account-specific prefix. A map describes a path convention; it does not check whether a remote file exists.

The raw `config.json` schema remains version 1. `knowledgeDir` is computed from `dataDir`, so a v0.1 configuration still works without being rewritten. A custom `--directory` changes the destination for that command, not the configured default or the server roots.

## How candidate kinds relate to the files

| Candidate kind | Related navigation/record destination |
| --- | --- |
| `profile` | `PROFILE.md` |
| `preference` | `PREFERENCES.md` |
| `current` | `CURRENT.md` |
| `knowledge` | `08-学习与知识/`, `17-决策与经验/`, or the relevant topic folder |

This guidance connects the candidate vocabulary to the local organization. Candidate input remains exactly `summary`, `kind`, and `source`. Approving a candidate submits a selected summary through the established capture flow; it does not automatically edit a Markdown file or upload an entire topic directory. Only read relevant existing information when the current task needs it. Template names, instructions, examples, and placeholders are not current-human statements.

## Import and privacy boundaries

Initialization and mapping make no network request, create no remote resource, and do not import existing records. There is no automatic directory upload, watcher, Git-based knowledge saving, or synchronization. The read-only MCP remains read-only. A previous archive requires a separate explicit, reviewed migration workflow; this release does not provide one.

Once filled, local Markdown may be highly sensitive and is not encrypted by the candidate vault. Keep the knowledge directory in private application data, outside the source checkout, and review any backup/sync service you choose yourself. The shipped generic template is public; user-filled files are not release assets.
