self.onmessage = ({ data }) => {
  const regex = new RegExp(data.pattern, data.flags);
  for (const sample of data.samples) {
    regex.test(sample);
  }
  self.postMessage("done");
};

self.postMessage("ready");
