import { describe, expect, it } from 'vitest'
import {
  parseCanonicalArticle,
  renderCanonicalArticle,
  withoutCanonicalDividers,
} from '../canonical'

describe('canonical platform normalization', () => {
  it('removes package dividers and recalculates image anchors for Zhihu', () => {
    const source = parseCanonicalArticle(
      '<p>开头</p><hr><img src="one.jpg" alt="图片1：示意图"><hr><p>结尾</p>',
      '标题',
    )

    const normalized = withoutCanonicalDividers(source)

    expect(normalized.blocks.map((block) => block.kind)).toEqual(['paragraph', 'image', 'paragraph'])
    expect(normalized.images[0]).toMatchObject({ order: 1, anchor: 1, alt: '示意图' })
    expect(renderCanonicalArticle(normalized)).not.toContain('<hr>')
  })
})
