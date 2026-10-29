# 风场数字孪生技能库

共9个技能：1个总控、8个独立模块。包含独立项目模板、配置样例与初始化脚本；不包含当前项目的测量文件、原始图纸、地形缓存和密钥。当前运行项目未修改。

## 入口

向Codex发送：

> 使用这个文件夹下 windfarm-digital-twin/SKILL.md，总领各模块，根据我提供的风场数据生成一个新的数字孪生项目。

也可直接引用单个模块的SKILL.md处理专项任务。文件夹没有安装到全局；需要自动发现时，将整组技能放入自己的技能目录，保留兄弟目录结构。

| 文件夹 | 能力 |
|---|---|
| windfarm-digital-twin | 总控、项目初始化、配置和模块路由 |
| windfarm-layout | 页面、面板、显示设置、CAD交互和指北针 |
| windfarm-coordinates | 数据格式、坐标转换和审计 |
| windfarm-map-terrain | Cesium、卫星底图、DEM及贴地 |
| windfarm-turbines | 塔筒、连续叶片、机舱和标签 |
| windfarm-towers | 图纸建塔、单双回路、挂点、耐张串及拓扑 |
| windfarm-roads | DXF道路、宽度、样式控制 |
| windfarm-energy | 8760面积图、区间缩放、时间轴及出力估算 |
| windfarm-performance | 性能优化和验收 |

## 快速生成

1. 复制 `windfarm-digital-twin/references/project.config.example.json` 到工作目录，填写项目名称、位置、坐标带号和文件名；叶轮直径默认随参数表，配置值仅用于覆盖。杆塔文件存在时必须提供线路顺序与跨线连接，不能靠塔号或最近邻猜测。
2. 准备新输入目录。风机必需，杆塔、道路和逐时电量可选；输入格式见总控的 `references/data-contract.md`。
3. 在本目录运行（替换尖括号参数）：

```powershell
python windfarm-digital-twin/scripts/new_project.py --target <新的项目目录> --config <配置JSON> --input-dir <数据目录>
```

4. 进入新目录：

```powershell
python -m pip install -r requirements.txt
python src/run_pipeline.py --prepare
python src/run_pipeline.py --fetch-dem
python -m http.server 8123 --bind 127.0.0.1
```

浏览器打开 http://127.0.0.1:8123/index.html。已有核对过原点、范围和坐标系的DEM时，可用 `--offline` 仅打包。不要复制上一个项目的DEM或site-data.js。

## 复用范围

同字段结构的文件替换后可快速导入；坐标基准、文件结构、混装机型、塔型图纸、线路拓扑或闰年时序变化，需要更新配置或适配器。当前通用模板仍是局部场址展示方案，不是工程校核软件。J1/SJ1模型是示例，尺寸需要本项目图纸确认。单机逐时功率由全场电量和等效小时估算，不能当实测。

## 已验证

9个SKILL通过quick_validate；模板JS通过语法检查。独立新目录使用参考输入完成四类导入、30m距离检查与前端打包；同原点DEM复用仅用于本次离线测试。未对生成项目进行新的浏览器视觉验收，也未重采网络地形。测试项目保存在原项目tmp下，不属于技能包。
