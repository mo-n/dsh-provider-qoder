# Support Global and China service regions via settings configuration

We support both Global (`qoder.com`) and China (`qoder.com.cn`) Qoder service regions via a single `region` setting in the `provider-qoder` namespace, rather than requiring manual endpoint entry or maintaining separate provider plugins.

While both regions share the same underlying COSY authentication algorithm and request payload formats, they operate on separate network endpoints and host distinct model catalogs.

Storing `region` in DSH settings preserves a single Managed Qoder PAT credential while allowing subscribers to switch environments, flush in-memory job tokens, and dynamically discover the model catalog corresponding to their active region.
