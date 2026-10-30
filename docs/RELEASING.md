# 版本与发布规则

## 版本号规则

版本号**只增不减**，每次发版 patch 位 +1，后缀表示阶段：

| 阶段 | 后缀 | 含义 |
| --- | --- | --- |
| Alpha | `-alpha` | 新功能刚做完，未验证是否有 bug |
| Beta | `-beta` | 修过一轮 bug，基本可用但不保证稳定 |
| 正式 | 无后缀 | beta 阶段结束、确认稳定后发布 |

示例（号连续递增，不重置）：

```
0.9.0-alpha   第一个 alpha
0.9.1-alpha   加功能 / 修 bug，仍是 alpha
0.9.2-alpha
0.9.3-beta    alpha 阶段收尾，转入 beta（号继续往上）
0.9.4-beta    修 beta 反馈的问题
0.9.5         正式版（无后缀）
0.9.6-alpha   下一个版本周期的第一个 alpha
```

要点：

- **同一阶段的版本号必须连续**，不允许重置回 0.9.0
- 进入 beta 不重置号，正式版也不重置
- 正式版发布后，下一轮从 `正式版号 + 0.0.1` 开始继续 alpha

## 不升版本号的情况

下面这些属于「同一版本内的修补」，直接改代码 / 替换资产 / 重发，**不递增版本号**：

- 文档、注释、措辞、链接写错
- 构建脚本、CI 配置、发布脚本的修正
- 仓库里误提交的内部信息、本机路径、临时文件
- 产物重新打包或资产替换（漏了图标、文件名写错、页面说明渲染错乱等）

判断标准只有一条：**用户能不能感知到功能或行为变化**。
只有功能变化、行为修复、稳定性提升才升版本；打包、文档、配置这类错误原地修掉，版本号不动。

## 发版流程（一条命令）

```bat
python tools/release.py alpha    :: 发 alpha
python tools/release.py beta     :: 发 beta
python tools/release.py stable   :: 发正式版
```

脚本会依次完成：

1. 读取 `Cargo.toml` 当前版本，patch +1 并套用新后缀
2. 同步更新 `Cargo.toml` 与 `README.md` 标题
3. 生成内嵌 UI 资源并编译 release
4. 推送源码到 GitHub
5. 创建 tag `vX.Y.Z[-stage]`、Release 与资产 `KeyClicker-X.Y.Z[-stage]-x64.exe`
6. 打 tag 后 GitHub Actions 会自动再构建一次并校验

## 产物命名

```
KeyClicker-<版本号>-x64.exe
例：KeyClicker-0.9.3-beta-x64.exe
```

Release 标题：`KeyClicker <版本号> (x64)`，alpha / beta 标记为 prerelease，正式版不标记。

## 说明

- 只有正式版（无后缀）才在 README 顶部写作当前版本
- alpha / beta 会在 Release 页面标注 “Pre-release”
- 版本号写在 `Cargo.toml` 的 `version` 字段，是唯一的权威来源
