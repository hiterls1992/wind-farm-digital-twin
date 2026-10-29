---
name: windfarm-map-terrain
description: 接入Cesium卫星底图、分级DEM、贴地几何及瓦片加载提示。
---

# 卫星地图与地形

复用模板libs/cesium及js/terrain.js，底图配置在js/config.js；密钥仅写config.local.js，勿复制旧项目私密配置。各影像源遵守坐标规则及服务署名。
通过fetch_dem按新项目中心采集L0/L1/L2；缓存签名含中心、步长、范围，批次校验条数、坐标、有限高程并原子保存。新项目不得复用旧地形与杆塔点高程。远离原点的线路检查覆盖范围，不足则扩网格。
贴地道路用CorridorGraphics和CLAMP_TO_GROUND；塔基由与前端一致的heightAt计算。展示DEM与实测高程差，不把30m DEM当施工测量。验收Python/JS高度一致、瓦片失败提示与相机碰撞。

## 复用资源

完整项目生成先读 [总控技能](../windfarm-digital-twin/SKILL.md)。代码位于其 `assets/project-template/`，只在目标项目修改副本，不修改技能库模板或其他项目。
