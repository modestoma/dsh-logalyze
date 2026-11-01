# 示例应用仓库：订单服务

演示观象要求的应用仓库结构：

```
.agents/logalyze.yaml                  应用描述（id、名称、别名、日志特征、分析 SKILL 名）
.agents/skills/log-analysis/SKILL.md   日志分析 SKILL，观象派发时用 /log-analysis 加载
src/                                   应用代码，子 Agent 对照它定位根因
sample-logs/order-service.log          一份示例日志（促销商品没有 SKU 导致 NullPointerException）
```

本地试用：把本目录复制出来初始化为 git 仓库，再在「观象」面板中添加它的绝对路径作为仓库地址（远程仓库填 https 地址）。

```sh
cp -r examples/order-service /tmp/order-service && cd /tmp/order-service
git init -q && git add -A && git commit -qm init
```

然后在对话中输入：

```
/logalyze 订单服务昨晚 21 点下单报 500，日志在 /tmp/order-service/sample-logs/order-service.log
```
