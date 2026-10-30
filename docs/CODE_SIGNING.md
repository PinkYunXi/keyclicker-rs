# 代码签名与 SmartScreen

> 目标：让 KeyClicker 从「未知发布者」变成有签名的可执行文件，减少 Windows Defender SmartScreen 拦截。

## 先说结论（避免踩坑）

1. **自签名证书没有用**：自己生成的证书（`New-SelfSignedCertificate`）不会进微软信任链，SmartScreen 仍会拦截，还可能让用户更困惑。不要用。
2. **没有「免费且立即生效」的证书**：SmartScreen 的即时信任来自 **EV 证书**（硬件令牌/云 HSM，均付费，约 $200–400/年）。
3. **免费可行的是「OV 证书」**：知名的是 **SignPath Foundation** 给开源项目免费签发。但 OV 证书**初期仍可能被 SmartScreen 提示**，需要累积下载量与时间（通常几天到几周）才会不再提示。
4. 签名只能证明「这个 exe 由项目方发布、且发布后未被篡改」，不能保证杀软不误报（杀软误报要靠提交申诉）。

## 本项目的现状

- 仓库：https://github.com/PinkYunXi/keyclicker-rs
- 许可证：MIT（OSI 认可，SignPath 要求之一）
- 已发布 Release：v0.9.0-beta 及 `KeyClicker-0.9.0-beta-x64.exe` 资产
- 构建产物：单文件 exe（约 2 MB），无安装器

满足 SignPath Foundation 的基本条件（公开开源项目 + 可复现构建 + Release 资产）。

## 申请步骤（需要项目所有者本人操作）

1. 打开 **https://signpath.org/apply** 填写申请表单（提交申请本身不需要账号）。
2. 表单需要填写：项目名、仓库地址、许可证、构建系统、项目简介与维护者信息。
3. 参考填写内容：
   - Repository：`https://github.com/PinkYunXi/keyclicker-rs`
   - License：MIT
   - 构建方式：GitHub Actions（仓库内已有 `.github/workflows/build.yml`）
   - 产物：`target/release/keyclicker-rs.exe`
4. 等待人工审核（通常几天到两周）。审核通过后会收到组织邀请。
5. 在 SignPath 控制台创建：
   - Project slug：`keyclicker-rs`
   - Artifact configuration slug：`exe`
   - Signing policy slug：`release-signing`
6. 把 `SIGNPATH_API_TOKEN`、`SIGNPATH_ORGANIZATION_ID` 写入仓库的 **Settings → Secrets and variables → Actions**。
7. 取消 `.github/workflows/build.yml` 中「签名 exe」整段的注释，之后每次打 tag 都会自动签名。

## 签名后的验证

```powershell
# 查看签名状态
Get-AuthenticodeSignature .\KeyClicker.exe | Format-List Status, SignerCertificate, TimeStamperCertificate

# 应输出 Status = Valid，且 TimeStamperCertificate 不为空（有时间戳，证书过期后签名仍有效）
```

## 本地签名命令（拿到证书文件时）

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f mycert.pfx /p <密码> KeyClicker.exe
```

## 替代方案对比

| 方案 | 费用 | 是否能消除 SmartScreen 提示 |
| --- | --- | --- |
| 自签名证书 | 免费 | 否，且更差 |
| SignPath Foundation（OV） | 免费（需审核） | 逐步消除，初期仍可能提示 |
| Certum / Sectigo 开源 OV | 约 €50–100/年 | 同上，需积累声誉 |
| Azure Trusted Signing | $9.99/月 | 审核后较好 |
| EV 代码签名证书 | $200–400/年 | 近乎即时建立信誉 |

## 参考

- SignPath Foundation：https://signpath.org/
- SignPath 开源签名说明：https://signpath.io/solutions/open-source-projects/
- SmartScreen 信誉机制：https://learn.microsoft.com/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/
