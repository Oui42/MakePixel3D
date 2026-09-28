# Zastępnik flash_attn.modules.mha.MHA – zgodny z oryginałem w zakresie, którego używa UniRig:
#   MHA(embed_dim, num_heads, cross_attn=True) i wywołanie attention(q, x_kv=kv).
# Nazwy parametrów jak w oryginale (Wqkv / Wq + Wkv / out_proj), żeby state_dict z checkpointu pasował.
import torch
import torch.nn as nn
import torch.nn.functional as F


class MHA(nn.Module):
    def __init__(self, embed_dim, num_heads, cross_attn=False, qkv_proj_bias=True, out_proj_bias=True,
                 dropout=0.0, causal=False, layer_idx=None, dwconv=False, rotary_emb_dim=0, use_flash_attn=False,
                 return_residual=False, checkpointing=False, device=None, dtype=None, **_kwargs):
        super().__init__()
        assert not dwconv and not rotary_emb_dim, "zastępnik MHA: bez dwconv i rotary"
        self.embed_dim = embed_dim
        self.num_heads = num_heads
        self.head_dim = embed_dim // num_heads
        self.cross_attn = cross_attn
        self.causal = causal
        self.dropout = dropout
        self.return_residual = return_residual
        kw = {"device": device, "dtype": dtype}
        if cross_attn:
            self.Wq = nn.Linear(embed_dim, embed_dim, bias=qkv_proj_bias, **kw)
            self.Wkv = nn.Linear(embed_dim, 2 * embed_dim, bias=qkv_proj_bias, **kw)
        else:
            self.Wqkv = nn.Linear(embed_dim, 3 * embed_dim, bias=qkv_proj_bias, **kw)
        self.out_proj = nn.Linear(embed_dim, embed_dim, bias=out_proj_bias, **kw)

    def _split(self, t, n):
        # (B, L, n*E) -> (B, H, L, n, D)
        b, l, _ = t.shape
        return t.view(b, l, n, self.num_heads, self.head_dim).permute(0, 3, 1, 2, 4)

    def forward(self, x, x_kv=None, key_padding_mask=None, **_kwargs):
        if self.cross_attn:
            q = self._split(self.Wq(x), 1)[:, :, :, 0]
            kv = self._split(self.Wkv(x_kv if x_kv is not None else x), 2)
            k, v = kv[:, :, :, 0], kv[:, :, :, 1]
        else:
            qkv = self._split(self.Wqkv(x), 3)
            q, k, v = qkv[:, :, :, 0], qkv[:, :, :, 1], qkv[:, :, :, 2]
        mask = None
        if key_padding_mask is not None:   # True = ważny token (jak w flash_attn)
            mask = key_padding_mask[:, None, None, :].to(torch.bool)
        out = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=self.dropout if self.training else 0.0,
                                             is_causal=self.causal and mask is None)
        out = out.permute(0, 2, 1, 3).reshape(x.shape[0], x.shape[1], self.embed_dim)
        out = self.out_proj(out)
        return (out, x) if self.return_residual else out
