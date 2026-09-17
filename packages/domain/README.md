# Domain

该目录用于领域服务和端口，不放 HTTP 路由、SQLite SQL、供应商响应或页面 ViewModel。

新增领域模块时采用相同结构：

```text
src/<domain>/entities
src/<domain>/commands
src/<domain>/services
src/<domain>/ports
```

B1/B2 已冻结 Contract、Repository 和模块注册规则。B3 已建立 Identity、Feed、Trading、Knowledge、Runtime
Service；旧接口由兼容端口继续提供，后续新能力直接落入对应领域 Service。
