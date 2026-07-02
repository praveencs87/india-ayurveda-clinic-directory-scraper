import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'ayurveda clinic', 
        location = 'Kerala', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'IN'
    });

    log.info(`Searching Indian Directories for "${keyword}" in "${location}"`);
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 1, // Keep concurrency low to avoid aggressive WAFs
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            await page.waitForSelector('.resultbox, .store-details, .jsx-164741473, .resultbox_info', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM.'));

            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Access Denied')) {
                throw new Error('Blocked by WAF. Retrying with residential proxy...');
            }

            // Scroll down a bit to trigger lazy loading
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);

            const items = await page.$$('.resultbox, .store-details, .jsx-164741473');
            
            for (const item of items) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('.store-name, .resultbox_title_anchor, h2');
                if (!nameElement) continue;
                const clinicName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.address, .resultbox_address, .font14.fw400.color111');
                const address = addressElement ? (await addressElement.innerText()).trim().replace(/\s+/g, ' ') : '';

                // Phones - Medical directories often hide or obfuscate
                const phoneElement = await item.$('a[href^="tel:"], .callcontent, .contact-info');
                let phone = '';
                if (phoneElement) {
                    const href = await phoneElement.getAttribute('href');
                    if (href && href.startsWith('tel:')) {
                        phone = href.replace('tel:', '').trim();
                    } else {
                        phone = (await phoneElement.innerText()).trim();
                    }
                }

                // Ratings
                const ratingElement = await item.$('.resultbox_totalrate, .rating_box, .green-box');
                const rating = ratingElement ? (await ratingElement.innerText()).trim() : '';
                
                // Reviews count
                const reviewElement = await item.$('.resultbox_countrate, .votes');
                const reviews = reviewElement ? (await reviewElement.innerText()).trim() : '';
                
                // URL
                const urlElement = await item.$('.resultbox_title_anchor, a.store-name');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://www.justdial.com').toString() : listingUrl;

                if (clinicName && clinicName.length > 1) {
                    const record = {
                        clinicName,
                        specialties: keyword,
                        address,
                        phone,
                        rating: `${rating} ${reviews}`.trim(),
                        listingUrl: fullListingUrl,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${clinicName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('a.next_page, a[rel="next"], .pagination-next');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://www.justdial.com').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                } else {
                    const currentUrl = new URL(request.url);
                    let pageNum = 1;
                    const match = currentUrl.pathname.match(/\/page-(\d+)/);
                    if (match) {
                        pageNum = parseInt(match[1]);
                        currentUrl.pathname = currentUrl.pathname.replace(/\/page-\d+/, `/page-${pageNum + 1}`);
                    } else {
                        currentUrl.pathname = currentUrl.pathname.replace(/\/$/, '') + '/page-2';
                    }
                    
                    if(pageNum < 10) { 
                        log.info(`Attempting synthetic pagination to: ${currentUrl.toString()}`);
                        await enqueueLinks({
                            urls: [currentUrl.toString()],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    const formatLocation = location.toLowerCase().replace(/\s+/g, '-');
    const formatKeyword = keyword.toLowerCase().replace(/\s+/g, '-');
    // Using Justdial as the primary engine for local healthcare discovery in India
    const startUrl = `https://www.justdial.com/${formatLocation}/${formatKeyword}`;
    
    await crawler.addRequests([{
        url: startUrl
    }]);

    await crawler.run();

    log.info(`🎉 Done! Extracted ${extractedCount} Indian Ayurveda clinic leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
