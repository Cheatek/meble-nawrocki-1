(function () {
  'use strict';

  var imagePath = /^\/?images\/(?:galery|uploads)\/[^?#]+\.(?:jpe?g|png|webp)$/i;
  var categories = new Set(['Kuchnie', 'Szafy', 'Zabudowy', 'Inne']);

  function validatePhoto(photo) {
    return photo &&
      typeof photo.image === 'string' &&
      imagePath.test(photo.image) &&
      typeof photo.alt === 'string' &&
      photo.alt.length > 0 &&
      photo.alt.length <= 300 &&
      categories.has(photo.category);
  }

  function createGallery(photos) {
    if (photos.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'gallery-empty';
      empty.textContent = 'Nowe realizacje pojawią się wkrótce.';
      return empty;
    }

    var list = document.createElement('ul');
    list.className = 'nospace gallery-grid';
    photos.forEach(function (photo) {
      var item = document.createElement('li');
      var link = document.createElement('a');
      var image = document.createElement('img');
      var category = document.createElement('span');
      var path = photo.image.replace(/^\//, '');

      link.href = path;
      image.src = path;
      image.alt = photo.alt;
      image.loading = 'lazy';
      image.decoding = 'async';
      category.className = 'gallery-category';
      category.textContent = photo.category;

      link.appendChild(image);
      item.appendChild(link);
      item.appendChild(category);
      list.appendChild(item);
    });
    return list;
  }

  fetch('data/gallery.json', { cache: 'no-cache' })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (data) {
      if (!data || !Array.isArray(data.photos) || data.photos.length > 500 ||
          !data.photos.every(validatePhoto)) {
        throw new Error('Nieprawidłowe dane galerii');
      }
      var current = document.querySelector('#gallery .gallery-grid, #gallery .gallery-empty');
      if (!current) throw new Error('Nie znaleziono kontenera galerii');
      current.replaceWith(createGallery(data.photos));
    })
    .catch(function (error) {
      console.error('Nie udało się odświeżyć galerii z data/gallery.json:', error);
    });
}());
