export class ArticleRepository {
  async getById() { throw new Error('ArticleRepository.getById 未实现'); }
  async save() { throw new Error('ArticleRepository.save 未实现'); }
  async list() { throw new Error('ArticleRepository.list 未实现'); }
  async clear() { throw new Error('ArticleRepository.clear 未实现'); }
}
export class InMemoryArticleRepository extends ArticleRepository {
  #articles = new Map();

  async getById(id) {
    const article = this.#articles.get(id);
    return article ? structuredClone(article) : null;
  }
  async save(article) {
    if (!article?.id) throw new Error('Article.id 不能为空');
    this.#articles.set(article.id, structuredClone(article));
    return article;
  }
  async list() { return [...this.#articles.values()].map((article) => structuredClone(article)); }
  async clear() { this.#articles.clear(); }
}
