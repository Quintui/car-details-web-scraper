import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs/promises";
import { URL } from "url";
import Papa from "papaparse";

interface Product {
  sku: string | null;
  siteCode: string | null;
  name: string | null;
  price: number | null;
  imageUrls: string[];
  productPageUrl: string | null;
  manufacturerCode: string | null;
  isInStock: boolean;
}

interface WooCommerceProductRow {
  ID: string;
  Type: string;
  SKU: string;
  Name: string;
  Published: string;
  "Is featured?": string;
  "Visibility in catalog": string;
  "Short description": string;
  Description: string;
  "Date sale price starts": string;
  "Date sale price ends": string;
  "Tax status": string;
  "Tax class": string;
  "In stock?": string;
  Stock: string;
  "Low stock amount": string;
  "Backorders allowed?": string;
  "Sold individually?": string;
  "Weight (kg)": string;
  "Length (cm)": string;
  "Width (cm)": string;
  "Height (cm)": string;
  "Allow customer reviews?": string;
  "Purchase note": string;
  "Sale price": string;
  "Regular price": string;
  Categories: string;
  Tags: string;
  "Shipping class": string;
  Images: string;
  "Download limit": string;
  "Download expiry days": string;
  Parent: string;
  "Grouped products": string;
  Upsells: string;
  "Cross-sells": string;
  "External URL": string;
  "Button text": string;
  Position: string;
}

const BASE_URL = "https://www.fastdeliverycarparts.com";
const START_URL =
  "https://www.fastdeliverycarparts.com/katalogs/?cat=38,4,23,95,1107,98,8,9,13,35,70,76,40,1103,1101,3,11,5,9000000423,9000000421,9000000422,32,14,19,16,15,31,20,99,97,46,47,71,41,80,85,79,78,84,81,1106,39,49,37,50,1116,54,51,105,57,52,58,59,60,67,68,30,1102,75,1104,66,101,102,64,109,36,18,34,1109,69,65,72,1108,2,104,42,6,1117,29,1118,43,17,7,45,10,44,24,28,22,106,108,55,96,92,1105,93,12,1112,94,86,88,89,87,91,77,63,21,103,27,61,107,25,1110,1113,1111,1114,56,1115";
const OUTPUT_CSV_FILE = "woocommerce_products.csv";
const MAX_CATALOG_PAGES = 1000;
const DELAY_BETWEEN_PRODUCT_REQUESTS_MS = 500;
const AXIOS_TIMEOUT_MS = 15000;

async function scrapeProductDetails(url: string): Promise<{
  manufacturerCode: string | null;
  isInStock: boolean;
  imageUrls: string[];
}> {
  let manufacturerCode: string | null = null;
  let isInStock = false;
  const imageUrls: string[] = [];

  if (!url) {
    console.warn("Skipping detail scraping due to missing URL.");
    return { manufacturerCode, isInStock, imageUrls };
  }

  console.log(` -> Fetching details from: ${url}`);
  try {
    const { data: html } = await axios.get(url, {
      timeout: AXIOS_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Expires: "0",
      },
    });

    const $ = cheerio.load(html);

    manufacturerCode = $("#tabs2-horizontal").text().trim() || null;

    const availabilityDiv = $("#single-item-card-right-column-blue-aviability");
    if (availabilityDiv.length > 0) {
      availabilityDiv.find("span.green").each((_idx, el) => {
        const stockText = $(el).text().trim();
        if (/\d+/.test(stockText)) {
          isInStock = true;
          return false;
        }
      });
    } else {
      console.warn(` -> Availability info div not found on ${url}`);
    }

    let mainImageUrl: string | null = null;
    const mainImgElement = $("#single-item-card-left-column-main-picture img");
    const mainImgSrc = mainImgElement.attr("src");
    if (mainImgSrc) {
      try {
        mainImageUrl = new URL(mainImgSrc, BASE_URL).toString();
        mainImageUrl = mainImageUrl.replace(/__\d+\//, "");
        if (!mainImageUrl.includes("default-image.png")) {
          imageUrls.push(mainImageUrl);
        } else {
          mainImageUrl = null;
        }
      } catch (e) {
        console.warn(` -> Could not parse main image URL: ${mainImgSrc}`);
      }
    }

    $("#single-item-card-left-column-thumbs img").each((_idx, thumbEl) => {
      const $thumb = $(thumbEl);
      const thumbDataPath = $thumb.attr("data-path");
      const thumbFilename = $thumb.attr("data-filename");

      if (thumbDataPath && thumbFilename) {
        try {
          const fullImageUrl = new URL(
            thumbDataPath + thumbFilename,
            BASE_URL
          ).toString();
          if (
            !fullImageUrl.includes("default-image.png") &&
            fullImageUrl !== mainImageUrl &&
            !imageUrls.includes(fullImageUrl)
          ) {
            imageUrls.push(fullImageUrl);
          }
        } catch (e) {
          console.warn(
            ` -> Could not construct thumb image URL from path: ${thumbDataPath} and file: ${thumbFilename}`
          );
        }
      }
    });

    if (imageUrls.length === 0) {
      try {
        imageUrls.push(new URL("/img/default-image.png", BASE_URL).toString());
      } catch {}
    }

    return { manufacturerCode, isInStock, imageUrls };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        ` -> Axios error fetching product details page ${url}: ${error.response?.status} ${error.message}`
      );
    } else {
      console.error(
        ` -> Error fetching/parsing product details page ${url}:`,
        error
      );
    }
    return { manufacturerCode: null, isInStock: false, imageUrls: [] };
  }
}

async function scrapeCatalogPage(url: string): Promise<{
  productsBaseInfo: Omit<
    Product,
    "manufacturerCode" | "isInStock" | "imageUrls"
  >[];
  nextPageUrl: string | null;
}> {
  console.log(`Fetching catalog page: ${url}`);
  try {
    const { data: html } = await axios.get(url, {
      timeout: AXIOS_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Expires: "0",
      },
    });

    const $ = cheerio.load(html);
    const productsBaseInfo: Omit<
      Product,
      "manufacturerCode" | "isInStock" | "imageUrls"
    >[] = [];

    $(".product-grid .item").each((_index, element) => {
      const productElement = $(element);
      const name = productElement.find(".product-name").text().trim() || null;
      let siteCode: string | null = null;
      const codeText = productElement.find(".detail-code").text().trim();
      if (codeText) {
        const codeMatch = codeText.match(/Detaļas kods:\s*(.*)/);
        if (codeMatch && codeMatch[1]) {
          siteCode = codeMatch[1].trim();
        }
      }
      let price: number | null = null;
      const priceStr = productElement
        .find(".price .currency")
        .attr("data-orig");
      if (priceStr) {
        const parsedPrice = parseFloat(priceStr);
        if (!isNaN(parsedPrice)) {
          price = parsedPrice;
        }
      }
      let productPageUrl: string | null = null;
      let sku: string | null = null;
      const relativeProductUrl = productElement
        .find(".product_info a")
        .attr("href");
      if (relativeProductUrl) {
        try {
          productPageUrl = new URL(relativeProductUrl, BASE_URL).toString();
          const urlParts = productPageUrl.split("/");
          const potentialId =
            urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
          if (potentialId && /^\d+$/.test(potentialId)) {
            sku = potentialId;
          } else {
            console.warn(
              `Could not extract numeric ID from product URL: ${productPageUrl}`
            );
          }
        } catch (e) {
          console.warn(
            `Could not construct absolute URL or extract SKU for product page: ${relativeProductUrl}`
          );
        }
      }

      if (name || siteCode || sku || price !== null || productPageUrl) {
        if (!(name && siteCode && sku && price !== null && productPageUrl)) {
          console.warn(
            `Product has missing base data but will still be included: Name=${name}, SKU=${sku}, SiteCode=${siteCode}, Price=${price}, PageURL=${productPageUrl}`
          );
        }
        productsBaseInfo.push({
          sku: sku || null,
          siteCode: siteCode || null,
          name: name || null,
          price: price !== undefined ? price : null,
          productPageUrl: productPageUrl || null,
        });
      }
    });

    let nextPageUrl: string | null = null;
    const nextLink = $(".pagination .next a").attr("href");
    if (nextLink) {
      try {
        const currentUrl = new URL(url);
        const nextUrl = new URL(nextLink, BASE_URL);
        if (currentUrl.searchParams.has("cat")) {
          nextUrl.searchParams.set("cat", currentUrl.searchParams.get("cat")!);
        }
        if (currentUrl.searchParams.has("pp")) {
          nextUrl.searchParams.set("pp", currentUrl.searchParams.get("pp")!);
        }
        nextPageUrl = nextUrl.toString();
      } catch (e) {
        console.warn(
          `Could not construct absolute URL for next page: ${nextLink}`
        );
      }
    }

    return { productsBaseInfo, nextPageUrl };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        `Axios error fetching catalog page ${url}: ${error.response?.status} ${error.message}`
      );
    } else {
      console.error(`Error fetching or parsing catalog page ${url}:`, error);
    }
    return { productsBaseInfo: [], nextPageUrl: null };
  }
}

function convertToWooCommerceCSV(products: Product[]): string {
  const wooCommerceData = products.map(
    (product): WooCommerceProductRow => ({
      ID: "",
      Type: "simple",
      SKU: product.sku || "",
      Name: product.name || "",
      Published: "1",
      "Is featured?": "0",
      "Visibility in catalog": "visible",
      "Short description": "",
      Description: `Manufacturer Code: ${
        product.manufacturerCode || "N/A"
      }\nSite Code: ${product.siteCode || "N/A"}`,
      "Date sale price starts": "",
      "Date sale price ends": "",
      "Tax status": "taxable",
      "Tax class": "",
      "In stock?": product.isInStock ? "1" : "0",
      Stock: "",
      "Low stock amount": "",
      "Backorders allowed?": "0",
      "Sold individually?": "0",
      "Weight (kg)": "",
      "Length (cm)": "",
      "Width (cm)": "",
      "Height (cm)": "",
      "Allow customer reviews?": "1",
      "Purchase note": "",
      "Sale price": "",
      "Regular price": product.price?.toString() || "",
      Categories: "",
      Tags: "",
      "Shipping class": "",
      Images: product.imageUrls.join(","),
      "Download limit": "",
      "Download expiry days": "",
      Parent: "",
      "Grouped products": "",
      Upsells: "",
      "Cross-sells": "",
      "External URL": "",
      "Button text": "",
      Position: "0",
    })
  );

  const csvString = Papa.unparse(wooCommerceData, {
    header: true,
    quotes: true,
    quoteChar: '"',
    escapeChar: '"',
    delimiter: ",",
    newline: "\r\n",
  });

  return csvString;
}

/**
 * Main function to orchestrate the scraping process.
 */
async function scrapeAllPages() {
  let allProducts: Product[] = [];
  let currentCatalogPageUrl: string | null = START_URL;
  let catalogPageCount = 0;

  console.log("Starting scraper...");

  while (currentCatalogPageUrl && catalogPageCount < MAX_CATALOG_PAGES) {
    catalogPageCount++;
    const { productsBaseInfo, nextPageUrl } = await scrapeCatalogPage(
      currentCatalogPageUrl
    );

    if (productsBaseInfo.length === 0 && catalogPageCount > 1) {
      console.log(
        `No products found on catalog page ${catalogPageCount}, stopping catalog pagination.`
      );
      break;
    }

    console.log(
      `Found ${productsBaseInfo.length} products on catalog page ${catalogPageCount}. Fetching details...`
    );

    for (let i = 0; i < productsBaseInfo.length; i++) {
      const baseInfo = productsBaseInfo[i];
      console.log(
        ` [${catalogPageCount}-${i + 1}/${
          productsBaseInfo.length
        }] Processing SKU: ${baseInfo.sku} (${baseInfo.name})`
      );

      if (!baseInfo.productPageUrl) {
        console.warn(
          ` -> Skipping detail fetch for product "${baseInfo.name}" (SKU: ${baseInfo.sku}) due to missing product page URL.`
        );
        continue;
      }

      const { manufacturerCode, isInStock, imageUrls } =
        await scrapeProductDetails(baseInfo.productPageUrl);

      const fullProductInfo: Product = {
        ...baseInfo,
        manufacturerCode: manufacturerCode,
        isInStock: isInStock,
        imageUrls: imageUrls,
      };
      allProducts.push(fullProductInfo);

      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BETWEEN_PRODUCT_REQUESTS_MS)
      );
    }

    if (nextPageUrl === currentCatalogPageUrl) {
      console.log("Next catalog page URL is the same as current, stopping.");
      break;
    }
    currentCatalogPageUrl = nextPageUrl;

    // Optional longer delay between catalog pages
    // await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (catalogPageCount >= MAX_CATALOG_PAGES) {
    console.warn(
      `Reached maximum catalog page limit (${MAX_CATALOG_PAGES}). Stopping.`
    );
  }

  console.log(
    `\nScraping finished. Scraped details for ${allProducts.length} products from ${catalogPageCount} catalog pages.`
  );

  if (allProducts.length > 0) {
    console.log("Converting data to WooCommerce CSV format...");
    try {
      const csvData = convertToWooCommerceCSV(allProducts);
      await fs.writeFile(OUTPUT_CSV_FILE, csvData, { encoding: "utf8" });
      console.log(
        `Successfully wrote ${allProducts.length} products to ${OUTPUT_CSV_FILE}`
      );
    } catch (error) {
      console.error(
        `Error converting or writing CSV to file ${OUTPUT_CSV_FILE}:`,
        error
      );
    }
  } else {
    console.log("No products were scraped, skipping CSV file generation.");
  }
}

scrapeAllPages().catch((error) => {
  console.error("An unexpected error occurred during scraping:", error);
});
