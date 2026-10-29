# 风机外观重建

参考：金风官方产品系列 https://www.goldwind.com/en/equipment/wind-turbine/ （6、7、8 MW）；远景官方产品页 https://www.envision-group.com/en/windturbines.html （6.X MW、EN-200/7）。公开图片辅助观察国内大兆瓦机组轮廓。

本模型采用通用外观，不代表项目已经选定某厂商机型。保留现有195 m叶轮直径及125 m轮毂高度。叶片弦长、厚度、扭角、后掠和机舱外壳尺寸为展示估计，不是厂家设计数据。

js/turbine-mesh.js生成连续翼型蒙皮、圆角机舱及流线型轮毂，js/app.js通过Cesium Primitive接入。转子每帧只更新矩阵；图层开关及显示倍率重建会同步管理新Primitive。叶轮平面前移6 m，降低叶片与塔筒相交。位置使用双精度。
