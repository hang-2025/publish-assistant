import { articleFromPackageDetail, articleFromScanResult } from '../domain/article.mjs';

export class ArticleService {
  constructor(repository) { this.repository = repository; }

  async indexScanResults(packages, context = {}) {
    // Scanner also emits diagnostic rows for skipped links/directories; only
    // signed package rows are Articles.
    const articles = packages.filter((pkg) => pkg?.packageId).map((pkg) => articleFromScanResult(pkg, context));
    await Promise.all(articles.map((article) => this.repository.save(article)));
    return articles;
  }

  async enrichPackage(detail) {
    const current = await this.repository.getById(detail.packageId);
    const article = articleFromPackageDetail(detail, current || {});
    await this.repository.save(article);
    return article;
  }
}
