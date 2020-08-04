// npx ts-node -r tsconfig-paths/register tscmd/dev/populate-revisions-given-title-cmd.ts


import { MwActionApiClient } from '@/shared/mwapi';
import { logger } from '@/server/common';
import { RevisionInfo, RevisionInfoProps } from '@/shared/models/revision-info.model';
import { FeedRevision, FeedRevisionProps } from '~/shared/models/feed-revision.model';
import { FeedPage } from '@/shared/models/feed-page.model';

const Bottleneck = require("bottleneck");
const getPair = function (wiki, result, pageId) {
  let revisions = result.query.pages[pageId].revisions;
  if (revisions.length > 1) {
    logger.info(`revisions.length > 1
title=${result.query.pages[pageId].title},
revId=${revisions[0].revid}
length=${revisions.length}`);
  }
  let revision = revisions[0];
  let wikiRevId = `${wiki}:${revision.revid}`;
  let revisionInfo = <RevisionInfoProps>{
    wikiRevId: wikiRevId,
    revId: revision.revid,
    wiki: wiki,
    pageId: parseInt(pageId),
    title: result.query.pages[pageId].title,
    wikiCreated: new Date(revision.timestamp),
    tags: revision.tags,
    summary: revision.comment,
    // skip diff
    // skip ores_damaging
    // skip ores_damaging
    prevRevId: revision.parentid
  };
  if (Object.keys(revision).indexOf('anon') /* anonymous */ >= 0) {
    revisionInfo.anonymousIp = revision.user
  } else revisionInfo.wikiUserName = revision.user
  if (revision.oresscores.damaging) revisionInfo.ores_damaging = revision.oresscores.damaging.true;
  if (revision.oresscores.badfaith) revisionInfo.ores_badfaith = revision.oresscores.goodfaith.false;

  let feedRevision = <FeedRevisionProps>{
    feed: 'us2020',
    wikiRevId: wikiRevId,
    title: result.query.pages[pageId].title,
    createdAt: new Date(),
    wiki: wiki,
    feedRankScore: 0,
  };
  return [revisionInfo, feedRevision]
};

const populateRevisionsGivenTitleMain = async function () {
  let neck = new Bottleneck({
    minTime: 500
  });
  const envPath = process.env.DOTENV_PATH || 'template.env';
  console.log(`DotEnv envPath = `, envPath, ' if you want to change it, restart and set DOTENV_PATH');

  require('dotenv').config({
    path: envPath
  });
  const mongoose = require('mongoose');
  console.log(`Connecting mongodb ...`);
  await mongoose.connect(process.env.MONGODB_URI, { useUnifiedTopology: true, useNewUrlParser: true });
  console.log(`Connected mongodb!`);

  let wiki = 'enwiki';
  let feed = 'us2020';
  await populateRevisionsGivenTitle(wiki, feed, neck);
  console.log(`done`);
}

populateRevisionsGivenTitleMain()
  .then(() => {
    console.log(`CMD Done!`);
    process.exit(0);
  });

async function populateRevisionsGivenTitle(wiki: string, feed: string, neck: any) {
  let articleLists = (await FeedPage.find({ wiki: wiki, feed: feed })).map(fp => fp.title);
  console.log(`XXX articleLists`, articleLists.join('    '));
  for (let articleIndex = 0; articleIndex < articleLists.length; articleIndex += 50) {
    let titles = articleLists.slice(articleIndex, Math.min(articleIndex + 50, articleLists.length));
    logger.warn(`Reading the articles ${articleIndex}， ${titles.join('|')}`);

    let wiki = 'enwiki';
    let result = await neck.schedule(async () => await MwActionApiClient.getLastRevisionsByTitles(titles, wiki));

    if (Object.keys(result.query.pages).length > 0) {
      let pageIds = Object.keys(result.query.pages);
      let revisionInfos = [];
      let feedRevisions = [];
      for (let pageId of pageIds) {
        if (result.query.pages[pageId].revisions?.length > 0) {
          let [revisionInfo, feedRevision] = getPair(wiki, result, pageId);
          revisionInfos.push(revisionInfo);
          feedRevisions.push(feedRevision);
        }
      }
      let ret = await Promise.all([
        RevisionInfo.bulkWrite(revisionInfos.map((ri: RevisionInfoProps) => {
          return {
            updateOne: {
              filter: { wikiRevId: ri.wikiRevId },
              update: { $set: ri },
              upsert: true
            }
          };
        })),
        FeedRevision.bulkWrite(feedRevisions.map((fr: FeedRevisionProps) => {
          return {
            updateOne: {
              filter: {
                title: fr.title,
                "$or": [
                  {
                    "claimerInfo": {
                      "$exists": false
                    }
                  },
                  {
                    "claimerInfo.checkedOfAt": {
                      "$exists": false
                    },
                    "claimExpiresAt": {
                      "$lte": new Date()
                    }
                  }
                ]
              },
              update: { $set: fr },
              upsert: true
            }
          };
        }))
      ]);
      console.log(`Current articleIndex=${articleIndex} Ret = `, JSON.stringify(ret, null, 2));
    }
  }
}

