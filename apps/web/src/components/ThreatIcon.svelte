<script lang="ts">
import type { ThreatType } from '@arpha/shared'
import { iconSvg } from '../lib/icons'

interface Props {
  type: ThreatType
  heading?: number | null
  size?: number
}
let { type, heading = null, size = 36 }: Props = $props()
const src = $derived(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(type))}`)
</script>

<img
  {src}
  alt=""
  width={size}
  height={size}
  style:transform={heading === null ? undefined : `rotate(${heading}deg)`}
/>

<style>
  img {
    flex: none;
    display: block;
  }
</style>
